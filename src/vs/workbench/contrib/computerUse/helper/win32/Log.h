/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The single diagnostic sink for the helper.
//
// stdout carries newline-delimited JSON protocol traffic ONLY. Every diagnostic — including
// anything you add while debugging — must go through this logger, which writes to stderr.
// A stray printf to stdout corrupts the stream and looks like a protocol bug in V3Code.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - Interleaving of stderr writes from the reader thread and the worker thread stays
//     line-atomic (the mutex here covers it, but fwrite buffering on stderr is unbuffered
//     by default on MSVC's CRT and that assumption is untested).
//
#pragma once

#include <string>

namespace v3cu {

enum class LogLevel {
	Error = 0,
	Warn = 1,
	Info = 2,
	Debug = 3,
};

/// Sets the minimum level that is written. Defaults to Info; V3CODE_COMPUTER_USE_LOG=debug
/// raises it to Debug at startup.
void SetLogLevel(LogLevel level);

/// Reads the level from the V3CODE_COMPUTER_USE_LOG environment variable, if set.
void InitLogFromEnvironment();

/// Writes one line to stderr, prefixed with the level. Never writes to stdout.
void LogLine(LogLevel level, const std::string& message);

inline void LogError(const std::string& message) { LogLine(LogLevel::Error, message); }
inline void LogWarn(const std::string& message) { LogLine(LogLevel::Warn, message); }
inline void LogInfo(const std::string& message) { LogLine(LogLevel::Info, message); }
inline void LogDebug(const std::string& message) { LogLine(LogLevel::Debug, message); }

} // namespace v3cu
