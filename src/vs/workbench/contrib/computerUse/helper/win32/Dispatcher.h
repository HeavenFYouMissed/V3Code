/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Request routing: protocol-version check, tier gate, then the handler.
//
// Order matters and is deliberate:
//   1. Protocol version. A mismatched caller gets helperVersionMismatch for everything except
//      `ping` and `status`, which must keep working so the service can diagnose the mismatch
//      instead of seeing an opaque failure.
//   2. Tier gate. See AppTiers.h for which methods are checked against which app.
//   3. The handler.
//
// An unknown method name is `internal` rather than a bespoke code, because the method table is
// generated from one TypeScript interface — an unknown method means the two sides were built from
// different sources, which is a bug, not a condition to handle.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - That the tier gate refuses a `type` while a terminal is focused, end to end.
//
#pragma once

#include "Protocol.h"

namespace v3cu {

/// Routes one request. Never throws; every failure becomes a MethodOutcome.
MethodOutcome Dispatch(const Request& request);

} // namespace v3cu
