const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const OpenAI = require("openai");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

exports.generateClarh = onRequest(
  { secrets: [OPENAI_API_KEY] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
      const { text, prompt } = req.body || {};
      const inputText = typeof text === "string" ? text : prompt;

      if (!inputText) {
        return res.status(400).json({ error: "Missing text" });
      }

      const easternNow = new Date().toLocaleString("sv-SE", {
        timeZone: "America/Toronto",
      });

      const systemPrompt = `
You are a strict classifier and date parser for a productivity app.

Your job is to analyze the user's input and return EXACTLY ONE JSON object
representing either a Task, Event, or Note.

You MUST follow all rules below.

────────────────────────
REFERENCE TIME
────────────────────────
Current reference datetime (Eastern Time, America/Toronto):
"${easternNow}"

Use this reference to interpret:
- today
- tomorrow
- next week
- this Friday

All dates MUST be calculated in America/Toronto time.

────────────────────────
TYPE DEFINITIONS
────────────────────────

TASK:
Something the user must DO.
Examples:
- "buy groceries tomorrow"
- "clean room"
- "submit assignment Friday"

Rules:
- Use ONLY due_date
- due_date = ISO date (YYYY-MM-DD)
- datetime MUST be null
- If no date mentioned → due_date = null

EVENT:
Something that happens at a specific time or place.
Examples:
- "dentist appointment tomorrow at 3pm"
- "dinner with John at 7pm"

Rules:
- Use ONLY datetime
- datetime = full ISO datetime (Eastern)
- due_date MUST be null
- readable_datetime SHOULD be provided if datetime exists

NOTE:
Informational only.

Rules:
- due_date = null
- datetime = null
- readable_datetime = null
- location = null

────────────────────────
OUTPUT JSON (STRICT)
────────────────────────

Return ONLY valid JSON with EXACTLY these keys:

{
  "type": "Task" | "Event" | "Note",

  "task_name": string | null,
  "event_name": string | null,
  "note_title": string | null,

  "due_date": string | null,
  "datetime": string | null,
  "readable_datetime": string | null,

  "location": string | null,
  "original_text": string
}

────────────────────────
NAMING RULES
────────────────────────
- task_name: 2–4 word action
- event_name: short title
- note_title: 1–3 word topic

────────────────────────
LOCATION RULES
────────────────────────
Only extract location if explicitly stated.
Otherwise set location = null.
Never guess.

────────────────────────
FINAL ENFORCEMENT
────────────────────────
- Task → datetime MUST be null
- Event → due_date MUST be null
- Note → ALL date fields MUST be null
- Return ONLY JSON

User text:
"${inputText}"
`;

      const client = new OpenAI({
        apiKey: OPENAI_API_KEY.value(),
      });

      const completion = await client.responses.create({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: inputText },
        ],
        temperature: 0.1,
      });

      const raw = completion.output_text;
      console.log("RAW:", raw);

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        data = match ? JSON.parse(match[0]) : {};
      }

      data.original_text = inputText;

      if (!data.type) data.type = "Note";
      if (!("location" in data)) data.location = null;

      if (data.type === "Task") {
        data.datetime = null;
        data.readable_datetime = null;
        if (!data.task_name) data.task_name = inputText.slice(0, 30);
      }

      if (data.type === "Event") {
        data.due_date = null;
        if (!data.event_name) data.event_name = inputText.slice(0, 30);
      }

      if (data.type === "Note") {
        data.due_date = null;
        data.datetime = null;
        data.readable_datetime = null;
        data.location = null;
        if (!data.note_title) data.note_title = inputText.slice(0, 20);
      }

      return res.json(data);
    } catch (err) {
      console.error("ERROR:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);
