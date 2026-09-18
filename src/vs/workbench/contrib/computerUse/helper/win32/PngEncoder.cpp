/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// WIC PNG encoder implementation. See PngEncoder.h for what is unverified.
// NEEDS VERIFICATION ON WINDOWS (full list in PngEncoder.h):
//   - CLSID_WICImagingFactory creatable from an MTA thread.
//   - The encoded PNG being opaque and decodable by Node.
//   - SHCreateMemStream linking against shlwapi.lib.
//
#include "PngEncoder.h"

#include "Log.h"

#include <shlwapi.h>
#include <wincodec.h>
#include <wrl/client.h>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

bool Failed(HRESULT hr, const char* what, std::string& error) {
	if (SUCCEEDED(hr)) {
		return false;
	}
	error = std::string(what) + " failed (" + FormatHResult(hr) + ")";
	LogWarn("png: " + error);
	return true;
}

/// Reads an IStream from position 0 to its end into a byte vector.
bool ReadStream(const ComPtr<IStream>& stream, std::vector<uint8_t>& out, std::string& error) {
	STATSTG stat = {};
	HRESULT hr = stream->Stat(&stat, STATFLAG_NONAME);
	if (Failed(hr, "IStream::Stat", error)) {
		return false;
	}
	if (stat.cbSize.HighPart != 0) {
		error = "encoded png is implausibly large";
		return false;
	}
	const ULONG size = stat.cbSize.LowPart;

	LARGE_INTEGER zero = {};
	hr = stream->Seek(zero, STREAM_SEEK_SET, nullptr);
	if (Failed(hr, "IStream::Seek", error)) {
		return false;
	}

	out.assign(static_cast<size_t>(size), 0);
	ULONG totalRead = 0;
	while (totalRead < size) {
		ULONG readThisTime = 0;
		hr = stream->Read(out.data() + totalRead, size - totalRead, &readThisTime);
		if (Failed(hr, "IStream::Read", error)) {
			return false;
		}
		if (readThisTime == 0) {
			error = "IStream::Read returned no bytes before the end of the stream";
			return false;
		}
		totalRead += readThisTime;
	}
	return true;
}

} // namespace

bool EncodeBgraToPng(const uint8_t* pixels,
	int sourceWidth,
	int sourceHeight,
	int sourceStride,
	int targetWidth,
	int targetHeight,
	std::vector<uint8_t>& out,
	std::string& error) {
	if (pixels == nullptr || sourceWidth <= 0 || sourceHeight <= 0 || sourceStride <= 0) {
		error = "invalid source image";
		return false;
	}
	if (targetWidth <= 0 || targetHeight <= 0) {
		error = "invalid target size";
		return false;
	}

	ComPtr<IWICImagingFactory> factory;
	HRESULT hr = ::CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
		IID_PPV_ARGS(&factory));
	if (Failed(hr, "CoCreateInstance(WICImagingFactory)", error)) {
		return false;
	}

	const UINT bufferSize = static_cast<UINT>(sourceStride) * static_cast<UINT>(sourceHeight);
	ComPtr<IWICBitmap> sourceBitmap;
	hr = factory->CreateBitmapFromMemory(static_cast<UINT>(sourceWidth),
		static_cast<UINT>(sourceHeight), GUID_WICPixelFormat32bppBGRA,
		static_cast<UINT>(sourceStride), bufferSize, const_cast<BYTE*>(pixels), &sourceBitmap);
	if (Failed(hr, "CreateBitmapFromMemory", error)) {
		return false;
	}

	// Only scale when the target differs; WICBitmapInterpolationModeFant is the highest-quality
	// downscale WIC offers and is the right choice for text-heavy screenshots.
	ComPtr<IWICBitmapSource> encodeSource;
	if (targetWidth == sourceWidth && targetHeight == sourceHeight) {
		encodeSource = sourceBitmap;
	} else {
		ComPtr<IWICBitmapScaler> scaler;
		hr = factory->CreateBitmapScaler(&scaler);
		if (Failed(hr, "CreateBitmapScaler", error)) {
			return false;
		}
		hr = scaler->Initialize(sourceBitmap.Get(), static_cast<UINT>(targetWidth),
			static_cast<UINT>(targetHeight), WICBitmapInterpolationModeFant);
		if (Failed(hr, "IWICBitmapScaler::Initialize", error)) {
			return false;
		}
		encodeSource = scaler;
	}

	// SHCreateMemStream gives a growable in-memory IStream; the alternative
	// (IWICStream::InitializeFromMemory) needs the final size up front, which is unknowable
	// before encoding.
	ComPtr<IStream> stream;
	stream.Attach(::SHCreateMemStream(nullptr, 0));
	if (!stream) {
		error = "SHCreateMemStream returned null";
		return false;
	}

	ComPtr<IWICBitmapEncoder> encoder;
	hr = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
	if (Failed(hr, "CreateEncoder(png)", error)) {
		return false;
	}
	hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
	if (Failed(hr, "IWICBitmapEncoder::Initialize", error)) {
		return false;
	}

	ComPtr<IWICBitmapFrameEncode> frame;
	ComPtr<IPropertyBag2> frameProperties;
	hr = encoder->CreateNewFrame(&frame, &frameProperties);
	if (Failed(hr, "CreateNewFrame", error)) {
		return false;
	}
	hr = frame->Initialize(frameProperties.Get());
	if (Failed(hr, "IWICBitmapFrameEncode::Initialize", error)) {
		return false;
	}
	hr = frame->SetSize(static_cast<UINT>(targetWidth), static_cast<UINT>(targetHeight));
	if (Failed(hr, "IWICBitmapFrameEncode::SetSize", error)) {
		return false;
	}

	// The encoder may substitute a nearby format; WriteSource converts as needed, so a changed
	// format here is not an error.
	WICPixelFormatGUID pixelFormat = GUID_WICPixelFormat32bppBGRA;
	hr = frame->SetPixelFormat(&pixelFormat);
	if (Failed(hr, "IWICBitmapFrameEncode::SetPixelFormat", error)) {
		return false;
	}

	hr = frame->WriteSource(encodeSource.Get(), nullptr);
	if (Failed(hr, "IWICBitmapFrameEncode::WriteSource", error)) {
		return false;
	}
	hr = frame->Commit();
	if (Failed(hr, "IWICBitmapFrameEncode::Commit", error)) {
		return false;
	}
	hr = encoder->Commit();
	if (Failed(hr, "IWICBitmapEncoder::Commit", error)) {
		return false;
	}

	return ReadStream(stream, out, error);
}

} // namespace v3cu
