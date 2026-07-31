/**
 * Schema JSON kỳ vọng đầu ra khi sinh spin theo sao (1 call → nhiều mức).
 * Hiển thị trên Admin → DeepSeek. API dùng json_object (DeepSeek không hỗ trợ json_schema).
 */
export const STAR_SPIN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    templates: {
      type: "array",
      description: "Một template spin cho mỗi mức sao cần sinh",
      items: {
        type: "object",
        properties: {
          stars: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description: "Mức sao 1-5",
          },
          template: {
            type: "string",
            minLength: 1,
            description: "Spin template có block {a|b|c}",
          },
        },
        required: ["stars", "template"],
        additionalProperties: false,
      },
    },
  },
  required: ["templates"],
  additionalProperties: false,
} as const;

/** response_format gửi lên DeepSeek — json_object (hỗ trợ ổn định). */
export const STAR_SPIN_RESPONSE_FORMAT = {
  type: "json_object",
} as const;

/** Alias — cùng json_object. */
export const STAR_SPIN_RESPONSE_FORMAT_JSON_OBJECT = STAR_SPIN_RESPONSE_FORMAT;
