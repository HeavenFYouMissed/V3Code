/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// A minimal JSON value, parser and serializer.
//
// Hand-rolled because the helper may not take third-party dependencies. Scope is exactly what
// the wire contract needs: objects, arrays, strings, numbers, booleans and null. No comments,
// no trailing commas, no NaN/Infinity.
//
// Absent optional fields are represented by simply not setting the key, which is what the
// contract requires (`label?: string` must be omitted, not emitted as null).
//
// NEEDS VERIFICATION ON WINDOWS:
//   - Nothing platform-specific. Behaviour is standard C++17, but the parser has never been
//     run: worth a unit test on the first Windows machine (see the round-trip note in
//     Json.cpp).
//
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace v3cu {

class JsonValue {
public:
	enum class Type {
		Null,
		Bool,
		Int,
		Double,
		String,
		Array,
		Object,
	};

	// std::vector<JsonValue> / std::map<std::string, JsonValue> with JsonValue still incomplete
	// is well-defined for these two containers since C++17.
	using Array = std::vector<JsonValue>;
	using Object = std::map<std::string, JsonValue>;

	JsonValue() = default;

	static JsonValue MakeNull();
	static JsonValue MakeBool(bool value);
	static JsonValue MakeInt(int64_t value);
	static JsonValue MakeDouble(double value);
	static JsonValue MakeString(std::string value);
	static JsonValue MakeArray();
	static JsonValue MakeObject();

	Type GetType() const { return type_; }
	bool IsNull() const { return type_ == Type::Null; }
	bool IsBool() const { return type_ == Type::Bool; }
	bool IsNumber() const { return type_ == Type::Int || type_ == Type::Double; }
	bool IsString() const { return type_ == Type::String; }
	bool IsArray() const { return type_ == Type::Array; }
	bool IsObject() const { return type_ == Type::Object; }

	/// Accessors that never throw: they return the supplied fallback on a type mismatch. This is
	/// deliberate — malformed input from the wire must produce a typed protocol error, not a crash.
	bool AsBool(bool fallback = false) const;
	int64_t AsInt(int64_t fallback = 0) const;
	double AsDouble(double fallback = 0.0) const;
	const std::string& AsString(const std::string& fallback) const;

	const Array& AsArray() const;
	const Object& AsObject() const;

	/// Object member lookup. Returns nullptr when this is not an object or the key is absent.
	const JsonValue* Find(const std::string& key) const;

	/// True when the key is present and not null.
	bool Has(const std::string& key) const;

	/// Mutators. Set* on a non-matching type first converts this value to the required type.
	void Set(const std::string& key, JsonValue value);
	void Push(JsonValue value);

	/// Serializes to compact JSON with no newlines, safe to write as one protocol line.
	std::string Serialize() const;

	/// Parses `text`. Returns false and leaves `out` untouched on any syntax error, setting
	/// `errorMessage` to a short human-readable reason.
	static bool Parse(const std::string& text, JsonValue& out, std::string& errorMessage);

private:
	Type type_ = Type::Null;
	bool bool_ = false;
	int64_t int_ = 0;
	double double_ = 0.0;
	std::string string_;
	Array array_;
	Object object_;
};

/// Escapes a UTF-8 string into a JSON string literal, including the surrounding quotes.
std::string JsonEscape(const std::string& text);

} // namespace v3cu
