/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// JSON parser and serializer implementation.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - Round-trip of every shape in computerUseTypes.ts. Suggested smoke test, run once on a
//     Windows machine before trusting the helper:
//       echo {"id":1,"method":"ping","params":null,"protocolVersion":1} | v3code-computer-use.exe
//     and confirm exactly one line of JSON on stdout.
//   - Number formatting: integers must serialize without a decimal point, because the channel
//     compares pids and ids by strict equality after JSON.parse. Verified by reading, not running.
//
#include "Json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace v3cu {
namespace {

const std::string kEmptyString;
const JsonValue::Array kEmptyArray;
const JsonValue::Object kEmptyObject;

/// Appends `codepoint` to `out` as UTF-8.
void AppendUtf8(uint32_t codepoint, std::string& out) {
	if (codepoint <= 0x7f) {
		out.push_back(static_cast<char>(codepoint));
	} else if (codepoint <= 0x7ff) {
		out.push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
		out.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
	} else if (codepoint <= 0xffff) {
		out.push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
		out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
		out.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
	} else {
		out.push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
		out.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
		out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
		out.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
	}
}

class Parser {
public:
	Parser(const std::string& text) : text_(text) {}

	bool ParseValue(JsonValue& out);
	bool AtEndAfterWhitespace();
	const std::string& Error() const { return error_; }

private:
	bool Fail(const char* message) {
		if (error_.empty()) {
			error_ = message;
		}
		return false;
	}
	void SkipWhitespace();
	bool Peek(char& ch) const;
	bool ParseObject(JsonValue& out);
	bool ParseArray(JsonValue& out);
	bool ParseString(std::string& out);
	bool ParseNumber(JsonValue& out);
	bool ParseLiteral(const char* literal);
	bool ParseHex4(uint32_t& out);

	const std::string& text_;
	size_t pos_ = 0;
	std::string error_;
};

void Parser::SkipWhitespace() {
	while (pos_ < text_.size()) {
		const char ch = text_[pos_];
		if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
			++pos_;
		} else {
			break;
		}
	}
}

bool Parser::Peek(char& ch) const {
	if (pos_ >= text_.size()) {
		return false;
	}
	ch = text_[pos_];
	return true;
}

bool Parser::AtEndAfterWhitespace() {
	SkipWhitespace();
	return pos_ >= text_.size();
}

bool Parser::ParseLiteral(const char* literal) {
	const size_t length = ::strlen(literal);
	if (text_.compare(pos_, length, literal) != 0) {
		return Fail("unexpected token");
	}
	pos_ += length;
	return true;
}

bool Parser::ParseHex4(uint32_t& out) {
	if (pos_ + 4 > text_.size()) {
		return Fail("truncated \\u escape");
	}
	uint32_t value = 0;
	for (int i = 0; i < 4; ++i) {
		const char ch = text_[pos_ + static_cast<size_t>(i)];
		value <<= 4;
		if (ch >= '0' && ch <= '9') {
			value |= static_cast<uint32_t>(ch - '0');
		} else if (ch >= 'a' && ch <= 'f') {
			value |= static_cast<uint32_t>(ch - 'a' + 10);
		} else if (ch >= 'A' && ch <= 'F') {
			value |= static_cast<uint32_t>(ch - 'A' + 10);
		} else {
			return Fail("bad hex digit in \\u escape");
		}
	}
	pos_ += 4;
	out = value;
	return true;
}

bool Parser::ParseString(std::string& out) {
	char ch = 0;
	if (!Peek(ch) || ch != '"') {
		return Fail("expected string");
	}
	++pos_;
	out.clear();
	while (pos_ < text_.size()) {
		const char current = text_[pos_++];
		if (current == '"') {
			return true;
		}
		if (current != '\\') {
			out.push_back(current);
			continue;
		}
		if (pos_ >= text_.size()) {
			return Fail("truncated escape");
		}
		const char escape = text_[pos_++];
		switch (escape) {
			case '"': out.push_back('"'); break;
			case '\\': out.push_back('\\'); break;
			case '/': out.push_back('/'); break;
			case 'b': out.push_back('\b'); break;
			case 'f': out.push_back('\f'); break;
			case 'n': out.push_back('\n'); break;
			case 'r': out.push_back('\r'); break;
			case 't': out.push_back('\t'); break;
			case 'u': {
				uint32_t first = 0;
				if (!ParseHex4(first)) {
					return false;
				}
				if (first >= 0xd800 && first <= 0xdbff) {
					// High surrogate: a low surrogate must follow, otherwise emit the replacement
					// character rather than an invalid codepoint.
					if (pos_ + 1 < text_.size() && text_[pos_] == '\\' && text_[pos_ + 1] == 'u') {
						pos_ += 2;
						uint32_t second = 0;
						if (!ParseHex4(second)) {
							return false;
						}
						if (second >= 0xdc00 && second <= 0xdfff) {
							const uint32_t combined =
								0x10000u + ((first - 0xd800u) << 10) + (second - 0xdc00u);
							AppendUtf8(combined, out);
							break;
						}
						AppendUtf8(0xfffdu, out);
						AppendUtf8(second, out);
						break;
					}
					AppendUtf8(0xfffdu, out);
					break;
				}
				AppendUtf8(first, out);
				break;
			}
			default:
				return Fail("unknown escape");
		}
	}
	return Fail("unterminated string");
}

bool Parser::ParseNumber(JsonValue& out) {
	const size_t start = pos_;
	if (pos_ < text_.size() && (text_[pos_] == '-' || text_[pos_] == '+')) {
		++pos_;
	}
	bool isDouble = false;
	while (pos_ < text_.size()) {
		const char ch = text_[pos_];
		if (ch >= '0' && ch <= '9') {
			++pos_;
		} else if (ch == '.' || ch == 'e' || ch == 'E' || ch == '+' || ch == '-') {
			isDouble = true;
			++pos_;
		} else {
			break;
		}
	}
	if (pos_ == start) {
		return Fail("expected number");
	}
	const std::string token = text_.substr(start, pos_ - start);
	if (isDouble) {
		out = JsonValue::MakeDouble(::strtod(token.c_str(), nullptr));
	} else {
		out = JsonValue::MakeInt(static_cast<int64_t>(::_strtoi64(token.c_str(), nullptr, 10)));
	}
	return true;
}

bool Parser::ParseArray(JsonValue& out) {
	++pos_; // consume '['
	out = JsonValue::MakeArray();
	SkipWhitespace();
	char ch = 0;
	if (Peek(ch) && ch == ']') {
		++pos_;
		return true;
	}
	while (true) {
		JsonValue element;
		if (!ParseValue(element)) {
			return false;
		}
		out.Push(std::move(element));
		SkipWhitespace();
		if (!Peek(ch)) {
			return Fail("unterminated array");
		}
		if (ch == ',') {
			++pos_;
			continue;
		}
		if (ch == ']') {
			++pos_;
			return true;
		}
		return Fail("expected , or ] in array");
	}
}

bool Parser::ParseObject(JsonValue& out) {
	++pos_; // consume '{'
	out = JsonValue::MakeObject();
	SkipWhitespace();
	char ch = 0;
	if (Peek(ch) && ch == '}') {
		++pos_;
		return true;
	}
	while (true) {
		SkipWhitespace();
		std::string key;
		if (!ParseString(key)) {
			return false;
		}
		SkipWhitespace();
		if (!Peek(ch) || ch != ':') {
			return Fail("expected : after object key");
		}
		++pos_;
		JsonValue value;
		if (!ParseValue(value)) {
			return false;
		}
		out.Set(key, std::move(value));
		SkipWhitespace();
		if (!Peek(ch)) {
			return Fail("unterminated object");
		}
		if (ch == ',') {
			++pos_;
			continue;
		}
		if (ch == '}') {
			++pos_;
			return true;
		}
		return Fail("expected , or } in object");
	}
}

bool Parser::ParseValue(JsonValue& out) {
	SkipWhitespace();
	char ch = 0;
	if (!Peek(ch)) {
		return Fail("unexpected end of input");
	}
	switch (ch) {
		case '{': return ParseObject(out);
		case '[': return ParseArray(out);
		case '"': {
			std::string text;
			if (!ParseString(text)) {
				return false;
			}
			out = JsonValue::MakeString(std::move(text));
			return true;
		}
		case 't':
			if (!ParseLiteral("true")) {
				return false;
			}
			out = JsonValue::MakeBool(true);
			return true;
		case 'f':
			if (!ParseLiteral("false")) {
				return false;
			}
			out = JsonValue::MakeBool(false);
			return true;
		case 'n':
			if (!ParseLiteral("null")) {
				return false;
			}
			out = JsonValue::MakeNull();
			return true;
		default:
			return ParseNumber(out);
	}
}

void SerializeInto(const JsonValue& value, std::string& out) {
	switch (value.GetType()) {
		case JsonValue::Type::Null:
			out += "null";
			return;
		case JsonValue::Type::Bool:
			out += value.AsBool() ? "true" : "false";
			return;
		case JsonValue::Type::Int: {
			char buffer[32] = {};
			::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "%lld",
				static_cast<long long>(value.AsInt()));
			out += buffer;
			return;
		}
		case JsonValue::Type::Double: {
			const double number = value.AsDouble();
			if (!std::isfinite(number)) {
				// JSON has no representation for these; 0 is the least harmful substitute and this
				// should never happen for the fields in the contract.
				out += "0";
				return;
			}
			char buffer[64] = {};
			::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "%.10g", number);
			out += buffer;
			return;
		}
		case JsonValue::Type::String:
			out += JsonEscape(value.AsString(kEmptyString));
			return;
		case JsonValue::Type::Array: {
			out += '[';
			bool first = true;
			for (const JsonValue& element : value.AsArray()) {
				if (!first) {
					out += ',';
				}
				first = false;
				SerializeInto(element, out);
			}
			out += ']';
			return;
		}
		case JsonValue::Type::Object: {
			out += '{';
			bool first = true;
			for (const auto& entry : value.AsObject()) {
				if (!first) {
					out += ',';
				}
				first = false;
				out += JsonEscape(entry.first);
				out += ':';
				SerializeInto(entry.second, out);
			}
			out += '}';
			return;
		}
	}
}

} // namespace

JsonValue JsonValue::MakeNull() {
	JsonValue value;
	value.type_ = Type::Null;
	return value;
}

JsonValue JsonValue::MakeBool(bool boolean) {
	JsonValue value;
	value.type_ = Type::Bool;
	value.bool_ = boolean;
	return value;
}

JsonValue JsonValue::MakeInt(int64_t number) {
	JsonValue value;
	value.type_ = Type::Int;
	value.int_ = number;
	return value;
}

JsonValue JsonValue::MakeDouble(double number) {
	JsonValue value;
	value.type_ = Type::Double;
	value.double_ = number;
	return value;
}

JsonValue JsonValue::MakeString(std::string text) {
	JsonValue value;
	value.type_ = Type::String;
	value.string_ = std::move(text);
	return value;
}

JsonValue JsonValue::MakeArray() {
	JsonValue value;
	value.type_ = Type::Array;
	return value;
}

JsonValue JsonValue::MakeObject() {
	JsonValue value;
	value.type_ = Type::Object;
	return value;
}

bool JsonValue::AsBool(bool fallback) const {
	return type_ == Type::Bool ? bool_ : fallback;
}

int64_t JsonValue::AsInt(int64_t fallback) const {
	if (type_ == Type::Int) {
		return int_;
	}
	if (type_ == Type::Double) {
		return static_cast<int64_t>(double_);
	}
	return fallback;
}

double JsonValue::AsDouble(double fallback) const {
	if (type_ == Type::Double) {
		return double_;
	}
	if (type_ == Type::Int) {
		return static_cast<double>(int_);
	}
	return fallback;
}

const std::string& JsonValue::AsString(const std::string& fallback) const {
	return type_ == Type::String ? string_ : fallback;
}

const JsonValue::Array& JsonValue::AsArray() const {
	return type_ == Type::Array ? array_ : kEmptyArray;
}

const JsonValue::Object& JsonValue::AsObject() const {
	return type_ == Type::Object ? object_ : kEmptyObject;
}

const JsonValue* JsonValue::Find(const std::string& key) const {
	if (type_ != Type::Object) {
		return nullptr;
	}
	const auto found = object_.find(key);
	return found == object_.end() ? nullptr : &found->second;
}

bool JsonValue::Has(const std::string& key) const {
	const JsonValue* found = Find(key);
	return found != nullptr && !found->IsNull();
}

void JsonValue::Set(const std::string& key, JsonValue value) {
	if (type_ != Type::Object) {
		type_ = Type::Object;
		object_.clear();
	}
	object_[key] = std::move(value);
}

void JsonValue::Push(JsonValue value) {
	if (type_ != Type::Array) {
		type_ = Type::Array;
		array_.clear();
	}
	array_.push_back(std::move(value));
}

std::string JsonValue::Serialize() const {
	std::string out;
	out.reserve(256);
	SerializeInto(*this, out);
	return out;
}

bool JsonValue::Parse(const std::string& text, JsonValue& out, std::string& errorMessage) {
	Parser parser(text);
	JsonValue parsed;
	if (!parser.ParseValue(parsed)) {
		errorMessage = parser.Error();
		return false;
	}
	if (!parser.AtEndAfterWhitespace()) {
		errorMessage = "trailing content after JSON value";
		return false;
	}
	out = std::move(parsed);
	return true;
}

std::string JsonEscape(const std::string& text) {
	std::string out;
	out.reserve(text.size() + 2);
	out.push_back('"');
	for (const char rawChar : text) {
		const unsigned char ch = static_cast<unsigned char>(rawChar);
		switch (ch) {
			case '"': out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\b': out += "\\b"; break;
			case '\f': out += "\\f"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			default:
				if (ch < 0x20) {
					char buffer[8] = {};
					::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "\\u%04x",
						static_cast<unsigned int>(ch));
					out += buffer;
				} else {
					// Bytes >= 0x80 are passed through: the input is already UTF-8, and JSON
					// permits raw UTF-8 in string literals.
					out.push_back(rawChar);
				}
				break;
		}
	}
	out.push_back('"');
	return out;
}

} // namespace v3cu
