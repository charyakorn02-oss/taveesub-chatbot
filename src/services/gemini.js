"use strict";

const axios = require("axios");
const { buildSystemPrompt } = require("../config/systemPrompt");

const DEFAULT_MODEL = "gemini-2.5-flash";
const MODEL = process.env.GEMINI_MODEL || DEFAULT_MODEL;
const MAX_ATTEMPTS = 3;
const MAX_HISTORY_MESSAGES = 20;

const ANALYSIS_FUNCTION = {
  name: "submit_customer_analysis",
  description:
    "Submit a structured analysis of the customer's latest message for routing and reply generation.",
  parameters: {
    type: "OBJECT",
    properties: {
      reply_text_to_customer: {
        type: "STRING",
        description: "The reply message to send back to the customer, in Thai.",
      },
      intent_category: {
        type: "STRING",
        enum: ["buying_new", "trade_in", "service", "general"],
        nullable: true,
        description:
          "Only classify as buying_new/trade_in/service when there is a clear signal in the conversation. Default to general when genuinely ambiguous.",
      },
      customer_name: {
        type: "STRING",
        nullable: true,
        description:
          "The customer's own name only. Never put a place/location name here, even if it was given in reply to a location question.",
      },
      model_or_issue: {
        type: "STRING",
        nullable: true,
        description: "Motorcycle model, or the issue/symptom described by the customer.",
      },
      delivery_preference: {
        type: "STRING",
        enum: ["pickup_at_branch", "home_delivery"],
        nullable: true,
      },
      location_text: {
        type: "STRING",
        nullable: true,
        description:
          "The customer's stated location/address text, verbatim, used to find the nearest branch. Never put a person's name here.",
      },
      requested_staff_name: {
        type: "STRING",
        nullable: true,
      },
      preferred_date: {
        type: "STRING",
        nullable: true,
      },
      phone: {
        type: "STRING",
        nullable: true,
      },
      high_intent_keyword: {
        type: "BOOLEAN",
      },
      in_scope: {
        type: "BOOLEAN",
      },
      has_confident_answer: {
        type: "BOOLEAN",
        description:
          "True unless this is a genuine factual question the FAQ/prompt cannot answer. Booking/scheduling requests should be true.",
      },
      data_complete: {
        type: "BOOLEAN",
      },
      fallback: {
        type: "BOOLEAN",
      },
    },
    required: [
      "reply_text_to_customer",
      "intent_category",
      "in_scope",
      "has_confident_answer",
      "data_complete",
    ],
  },
};

function buildKnownFactsPrefix(collected) {
  if (!collected || typeof collected !== "object") return "";
  const entries = Object.entries(collected).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );
  if (entries.length === 0) return "";
  const lines = entries.map(([k, v]) => `- ${k}: ${v}`);
  return `[ข้อมูลที่ทราบแล้วเกี่ยวกับลูกค้ารายนี้]\n${lines.join("\n")}\n\n`;
}

function mapHistoryToContents(history) {
  const trimmed = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_MESSAGES)
    : [];
  return trimmed
    .map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const text =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return { role, parts: [{ text }] };
    })
    .filter((m) => m.parts[0].text);
}

async function analyzeMessage(
  history,
  latestMessage,
  fallbackCount = 0,
  collected = null,
  imagePart = null
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const systemPrompt = await buildSystemPrompt();
  const knownFactsPrefix = buildKnownFactsPrefix(collected);
  const userText = `${knownFactsPrefix}${latestMessage || ""}`;

  const contents = mapHistoryToContents(history);

  const userParts = [{ text: userText }];
  if (imagePart && imagePart.data && imagePart.mimeType) {
    userParts.push({
      inlineData: {
        mimeType: imagePart.mimeType,
        data: imagePart.data,
      },
    });
  }
  contents.push({ role: "user", parts: userParts });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(
        url,
        {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: [{ functionDeclarations: [ANALYSIS_FUNCTION] }],
          tool_config: {
            function_calling_config: {
              mode: "ANY",
              allowed_function_names: ["submit_customer_analysis"],
            },
          },
          generationConfig: {
            temperature: 0.3,
          },
        },
        {
          params: { key: apiKey },
          timeout: 20000,
        }
      );

      const candidate = res.data && res.data.candidates && res.data.candidates[0];
      const parts = (candidate && candidate.content && candidate.content.parts) || [];
      const fnCallPart = parts.find((p) => p.functionCall);

      if (fnCallPart && fnCallPart.functionCall && fnCallPart.functionCall.args) {
        return fnCallPart.functionCall.args;
      }

      lastErr = new Error(
        `[gemini] no functionCall in response on attempt ${attempt}: ${JSON.stringify(
          res.data
        ).slice(0, 500)}`
      );
      console.warn(lastErr.message);
    } catch (err) {
      lastErr = err;
      if (err.response && err.response.data) {
        lastErr.responseData = err.response.data;
      }
      console.warn(`[gemini] request failed on attempt ${attempt}: ${err.message}`);
    }
  }

  throw lastErr || new Error("[gemini] analyzeMessage failed after retries");
}

module.exports = { analyzeMessage };
