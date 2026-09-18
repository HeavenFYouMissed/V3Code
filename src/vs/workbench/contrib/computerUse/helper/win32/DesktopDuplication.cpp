/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// DXGI Desktop Duplication implementation. Read DesktopDuplication.h for the list of unverified
// behaviours — it is long, and every item in it is a plausible source of a capture bug.
// NEEDS VERIFICATION ON WINDOWS (full list in DesktopDuplication.h):
//   - Output matching by device name, the AcquireNextFrame retry loop on a static desktop, hybrid
//     GPU laptops, rotated displays, and protected-content windows.
//   - That ReleaseFrame is reached on every path (it is called unconditionally after a successful
//     acquire below; a missed release deadlocks the next capture).
//
#include "DesktopDuplication.h"

#include "Log.h"

#include <cstring>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// How long one AcquireNextFrame waits, and how many times it is retried. On a static desktop
/// there are no updates to wait for, so timeouts are expected rather than exceptional.
constexpr UINT kAcquireTimeoutMs = 250;
constexpr int kAcquireAttempts = 8;

struct DuplicationCache {
	ComPtr<ID3D11Device> device;
	ComPtr<ID3D11DeviceContext> context;
	ComPtr<IDXGIOutputDuplication> duplication;
	std::wstring deviceName;

	void Reset() {
		duplication.Reset();
		context.Reset();
		device.Reset();
		deviceName.clear();
	}
};

DuplicationCache& Cache() {
	static DuplicationCache cache;
	return cache;
}

/// Finds the DXGI adapter and output that drive `deviceName` (e.g. "\\\\.\\DISPLAY1").
bool FindOutputForDevice(const std::wstring& deviceName, ComPtr<IDXGIAdapter1>& adapterOut,
	ComPtr<IDXGIOutput>& outputOut, DXGI_OUTPUT_DESC& descOut, std::string& error) {
	ComPtr<IDXGIFactory1> factory;
	HRESULT hr = ::CreateDXGIFactory1(IID_PPV_ARGS(&factory));
	if (FAILED(hr)) {
		error = "CreateDXGIFactory1 failed (" + FormatHResult(hr) + ")";
		return false;
	}

	for (UINT adapterIndex = 0;; ++adapterIndex) {
		ComPtr<IDXGIAdapter1> adapter;
		hr = factory->EnumAdapters1(adapterIndex, &adapter);
		if (hr == DXGI_ERROR_NOT_FOUND) {
			break;
		}
		if (FAILED(hr)) {
			error = "EnumAdapters1 failed (" + FormatHResult(hr) + ")";
			return false;
		}

		for (UINT outputIndex = 0;; ++outputIndex) {
			ComPtr<IDXGIOutput> output;
			hr = adapter->EnumOutputs(outputIndex, &output);
			if (hr == DXGI_ERROR_NOT_FOUND) {
				break;
			}
			if (FAILED(hr)) {
				break; // Move on to the next adapter rather than failing the whole capture.
			}

			DXGI_OUTPUT_DESC desc = {};
			if (FAILED(output->GetDesc(&desc))) {
				continue;
			}
			if (deviceName == desc.DeviceName) {
				adapterOut = adapter;
				outputOut = output;
				descOut = desc;
				return true;
			}
		}
	}

	error = "no DXGI output matches the monitor device name";
	return false;
}

/// Builds a device and duplication object for `monitor` and stores them in the cache.
bool BuildDuplication(const MonitorInfo& monitor, std::string& error) {
	Cache().Reset();

	ComPtr<IDXGIAdapter1> adapter;
	ComPtr<IDXGIOutput> output;
	DXGI_OUTPUT_DESC outputDesc = {};
	if (!FindOutputForDevice(monitor.deviceName, adapter, output, outputDesc, error)) {
		return false;
	}

	// A rotated desktop comes back rotated, and rotating it here by hand is exactly the kind of
	// clever code that is untestable from macOS. Refuse and let the GDI fallback handle it: BitBlt
	// of the screen DC returns the composited, already-upright image.
	if (outputDesc.Rotation != DXGI_MODE_ROTATION_IDENTITY &&
		outputDesc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
		error = "monitor is rotated; desktop duplication path declined";
		return false;
	}

	// D3D_DRIVER_TYPE_UNKNOWN is required when an adapter is supplied. The output must be
	// duplicated on the adapter that owns it.
	const D3D_FEATURE_LEVEL featureLevels[] = {
		D3D_FEATURE_LEVEL_11_0,
		D3D_FEATURE_LEVEL_10_1,
		D3D_FEATURE_LEVEL_10_0,
	};
	ComPtr<ID3D11Device> device;
	ComPtr<ID3D11DeviceContext> context;
	D3D_FEATURE_LEVEL selectedLevel = D3D_FEATURE_LEVEL_11_0;
	HRESULT hr = ::D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
		featureLevels, static_cast<UINT>(ARRAYSIZE(featureLevels)), D3D11_SDK_VERSION, &device,
		&selectedLevel, &context);
	if (FAILED(hr)) {
		error = "D3D11CreateDevice failed (" + FormatHResult(hr) + ")";
		return false;
	}

	ComPtr<IDXGIOutput1> output1;
	hr = output.As(&output1);
	if (FAILED(hr)) {
		error = "IDXGIOutput1 unavailable (" + FormatHResult(hr) + ")";
		return false;
	}

	ComPtr<IDXGIOutputDuplication> duplication;
	hr = output1->DuplicateOutput(device.Get(), &duplication);
	if (FAILED(hr)) {
		// E_ACCESSDENIED here means something else already owns duplication of this output, or the
		// session is on the secure desktop. Both are transient from the helper's point of view.
		error = "DuplicateOutput failed (" + FormatHResult(hr) + ")";
		return false;
	}

	Cache().device = device;
	Cache().context = context;
	Cache().duplication = duplication;
	Cache().deviceName = monitor.deviceName;
	return true;
}

/// Copies a duplicated desktop texture into `out`.
bool CopyTextureToFrame(const ComPtr<ID3D11Texture2D>& desktopTexture, const MonitorInfo& monitor,
	Frame& out, std::string& error) {
	D3D11_TEXTURE2D_DESC desktopDesc = {};
	desktopTexture->GetDesc(&desktopDesc);

	if (desktopDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
		error = "duplicated desktop is not B8G8R8A8_UNORM";
		return false;
	}

	D3D11_TEXTURE2D_DESC stagingDesc = {};
	stagingDesc.Width = desktopDesc.Width;
	stagingDesc.Height = desktopDesc.Height;
	stagingDesc.MipLevels = 1;
	stagingDesc.ArraySize = 1;
	stagingDesc.Format = desktopDesc.Format;
	stagingDesc.SampleDesc.Count = 1;
	stagingDesc.SampleDesc.Quality = 0;
	stagingDesc.Usage = D3D11_USAGE_STAGING;
	stagingDesc.BindFlags = 0;
	stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
	stagingDesc.MiscFlags = 0;

	ComPtr<ID3D11Texture2D> staging;
	HRESULT hr = Cache().device->CreateTexture2D(&stagingDesc, nullptr, &staging);
	if (FAILED(hr)) {
		error = "CreateTexture2D(staging) failed (" + FormatHResult(hr) + ")";
		return false;
	}

	Cache().context->CopyResource(staging.Get(), desktopTexture.Get());

	D3D11_MAPPED_SUBRESOURCE mapped = {};
	hr = Cache().context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
	if (FAILED(hr)) {
		error = "Map(staging) failed (" + FormatHResult(hr) + ")";
		return false;
	}

	out.width = static_cast<int>(desktopDesc.Width);
	out.height = static_cast<int>(desktopDesc.Height);
	out.stride = out.width * 4; // Repack tightly; the mapped row pitch is usually larger.
	out.pixels.assign(static_cast<size_t>(out.stride) * static_cast<size_t>(out.height), 0);
	out.sourceBounds = monitor.bounds;

	const auto* source = static_cast<const uint8_t*>(mapped.pData);
	for (int row = 0; row < out.height; ++row) {
		::memcpy(out.pixels.data() + static_cast<size_t>(row) * static_cast<size_t>(out.stride),
			source + static_cast<size_t>(row) * static_cast<size_t>(mapped.RowPitch),
			static_cast<size_t>(out.stride));
	}

	Cache().context->Unmap(staging.Get(), 0);
	return true;
}

} // namespace

void ResetDesktopDuplicationCache() {
	Cache().Reset();
}

bool CaptureMonitorWithDesktopDuplication(const MonitorInfo& monitor, Frame& out,
	std::string& error) {
	if (monitor.deviceName.empty()) {
		error = "monitor has no device name";
		return false;
	}

	if (!Cache().duplication || Cache().deviceName != monitor.deviceName) {
		if (!BuildDuplication(monitor, error)) {
			return false;
		}
	}

	for (int attempt = 0; attempt < kAcquireAttempts; ++attempt) {
		DXGI_OUTDUPL_FRAME_INFO frameInfo = {};
		ComPtr<IDXGIResource> desktopResource;
		const HRESULT hr =
			Cache().duplication->AcquireNextFrame(kAcquireTimeoutMs, &frameInfo, &desktopResource);

		if (hr == static_cast<HRESULT>(DXGI_ERROR_WAIT_TIMEOUT)) {
			// No screen update within the timeout. Nothing was acquired, so nothing to release.
			continue;
		}
		if (hr == static_cast<HRESULT>(DXGI_ERROR_ACCESS_LOST)) {
			// Resolution change, mode switch, UAC prompt or session change. Rebuild once.
			LogInfo("desktop duplication lost access; rebuilding");
			if (!BuildDuplication(monitor, error)) {
				return false;
			}
			continue;
		}
		if (FAILED(hr)) {
			error = "AcquireNextFrame failed (" + FormatHResult(hr) + ")";
			Cache().Reset();
			return false;
		}

		ComPtr<ID3D11Texture2D> desktopTexture;
		HRESULT castResult = desktopResource.As(&desktopTexture);
		bool copied = false;
		if (SUCCEEDED(castResult)) {
			copied = CopyTextureToFrame(desktopTexture, monitor, out, error);
		} else {
			error = "duplicated resource is not a texture (" + FormatHResult(castResult) + ")";
		}

		// ReleaseFrame must happen before the next AcquireNextFrame, on every path.
		Cache().duplication->ReleaseFrame();

		if (copied) {
			out.ForceOpaque();
			return true;
		}
		return false;
	}

	error = "desktop duplication produced no frame within the retry budget";
	return false;
}

} // namespace v3cu
