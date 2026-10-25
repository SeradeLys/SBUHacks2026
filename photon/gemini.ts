import { GoogleGenAI } from "@google/genai";

// Ask Gemini one question and get the answer back as text.
// Reads GEMINI_API (and optionally GEMINI_MODEL) from .env.
export async function askGemini(question: string): Promise<string> {
  const apiKey = process.env.GEMINI_API;
  if (!apiKey) throw new Error("Missing GEMINI_API.");
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    contents: question,
  });
  return res.text ?? "";
}

// Try it: bun gemini.ts "What is a healthy breakfast?"
if (import.meta.main) {
  const question = process.argv.slice(2).join(" ") || "Reply with the single word: pong";
  console.log(await askGemini(question));
}
