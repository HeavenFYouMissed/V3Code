/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// stderr logger implementation. See Log.h for why nothing may go to stdout.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - Nothing platform-specific beyond getenv_s; low risk.
//
#include "Log.h"

#include "Common.h"

#include <cstdio>
#include <cstdlib>
#include <mutex>

namespace v3cu {
namespace {

std::mutex& LogMutex() {
	static std::mutex mutex;
	return mutex;
}

LogLevel& CurrentLevel() {
	static LogLevel level = LogLevel::Info;
	return level;
}

const char* LevelName(LogLevel level) {
	switch (level) {
		case LogLevel::Error: return "error";
		case LogLevel::Warn: return "warn";
		case LogLevel::Info: return "info";
		case LogLevel::Debug: return "debug";
	}
	return "info";
}

} // namespace

void SetLogLevel(LogLevel level) {
	std::lock_guard<std::mutex> guard(LogMutex());
	CurrentLevel() = level;
}

void InitLogFromEnvironment() {
	char buffer[32] = {};
	size_t required = 0;
	if (::getenv_s(&required, buffer, sizeof(buffer), "V3CODE_COMPUTER_USE_LOG") != 0 || required == 0) {
		return;
	}
	const std::string value = ToLowerAscii(std::string(buffer));
	if (value == "debug") {
		SetLogLevel(LogLevel::Debug);
	} else if (value == "info") {
		SetLogLevel(LogLevel::Info);
	} else if (value == "warn") {
		SetLogLevel(LogLevel::Warn);
	} else if (value == "error") {
		SetLogLevel(LogLevel::Error);
	}
}

void LogLine(LogLevel level, const std::string& message) {
	std::lock_guard<std::mutex> guard(LogMutex());
	if (static_cast<int>(level) > static_cast<int>(CurrentLevel())) {
		return;
	}
	// One fprintf so the line cannot be split by a concurrent writer outside this mutex.
	::fprintf(stderr, "[v3code-computer-use][%s] %s\n", LevelName(level), message.c_str());
	::fflush(stderr);
}

} // namespace v3cu
