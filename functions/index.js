const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const OpenAI = require("openai");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

exports.generateClarh = onRequest(
  { secrets: [OPENAI_API_KEY] },
  async (req, res) => {
    // CORS
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

      // Eastern reference time (America/Toronto)
      const easternNow = new Date().toLocaleString("sv-SE", {
        timeZone: "America/Toronto",
      });

      /* ---------------- SYSTEM PROMPT ---------------- */

      const systemPrompt = `
You are a STRICT classifier and parser for a productivity app.

Your job:
- Classify input as Task, Event, or Note
- Extract dates, times, and locations
- Follow ALL rules exactly

────────────────────────
REFERENCE TIME
────────────────────────
Current datetime (America/Toronto):
"${easternNow}"

Use this to interpret:
- today
- tomorrow
- tonight
- later today
- next Friday
- in 2 hours

ALL dates MUST be Eastern Time.

────────────────────────
CORE DEFINITIONS
────────────────────────

1) TASK → user must TAKE ACTION

A Task is ANY text where the user is the implied actor of an action.
This includes casual, descriptive, or continuous phrasing.

Examples (ALL are Tasks):
- "wash dishes"
- "washing dishes today"
- "going grocery shopping tonight"
- "do laundry"
- "need to buy milk"
- "clean room tomorrow"

IMPORTANT:
- Imperative verbs are NOT required
- Continuous tense ("washing", "going", "doing") is STILL a Task
- Date words like "today" or "tonight" DO NOT make it an Event

Rules:
- May include date and/or location
- If date exists:
  - due_date = ISO start-of-day (00:00 Eastern)
  - datetime = ISO start-of-day (00:00 Eastern)
  - readable_datetime = friendly date (e.g. "Sun, 12/14")
- If NO date:
  - due_date = Inbox
  - datetime = Inbox
  - readable_datetime = Inbox

────────────────────────

2) EVENT → something that HAPPENS

Examples:
- "dentist appointment at 3pm"
- "birthday party Friday"
- "meeting at Starbucks"

Rules:
- Appointment / gathering nouns
- OR explicit time (3pm, 14:00, etc.)
- datetime REQUIRED (full ISO, Eastern)
- readable_datetime REQUIRED
- due_date MUST be null

────────────────────────

3) NOTE → informational only

Examples:
- "laptop charger broke"
- "idea for startup"
- "reading books is good"

Rules:
- due_date = null
- datetime = null
- readable_datetime = null
- location = null

────────────────────────
LOCATION EXTRACTION RULES
────────────────────────
Extract location if ANY place is mentioned.

Valid locations include:
- Businesses: Walmart, Starbucks, Costco
- Landmarks: mall, airport, City Hall
- Homes: mom's house, my place, home
- Proper nouns: Yorkdale, Eaton Centre
- Addresses: 123 Main St
- Anything following:
  at, in, to, from, near, by, around

If none → location = null  
Never guess.

────────────────────────
NAMING RULES
────────────────────────
- task_name → 2–4 word action
- event_name → short title
- note_title → 1–3 word topic

────────────────────────
OUTPUT JSON (ONLY THIS)
────────────────────────

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

Return ONLY valid JSON.

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
      console.log("OPENAI RAW:", raw);

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        data = match ? JSON.parse(match[0]) : {};
      }

      /* ---------------- SERVER GUARDRAILS (OPTION A) ---------------- */

      // Always preserve model's Task decision
      // Only force Event if explicit time or appointment noun exists
      const lower = inputText.toLowerCase();
      const hasExplicitTime =
        /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/.test(lower) ||
        /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(lower);

      const hasEventNoun =
        /\b(appointment|meeting|party|event|session|conference|wedding|dinner|lunch)\b/.test(
          lower
        );

      if (hasExplicitTime || hasEventNoun) {
        data.type = "Event";
      }

      // Final safety defaults
      if (!data.type) data.type = "Note";
      data.original_text = inputText;
      if (!("location" in data)) data.location = null;

      /* ---------------- NORMALIZATION ---------------- */

      if (data.type === "Task") {
        data.event_name = null;
        data.note_title = null;
        if (!data.task_name) {
          data.task_name = inputText.split(" ").slice(0, 4).join(" ");
        }
      }

      if (data.type === "Event") {
        data.task_name = null;
        data.note_title = null;
        data.due_date = null;
        if (!data.event_name) {
          data.event_name = inputText.split(" ").slice(0, 4).join(" ");
        }
      }

      if (data.type === "Note") {
        data.task_name = null;
        data.event_name = null;
        data.due_date = null;
        data.datetime = null;
        data.readable_datetime = null;
        data.location = null;
        if (!data.note_title) {
          data.note_title = inputText.split(" ").slice(0, 3).join(" ");
        }
      }

      return res.json(data);
    } catch (err) {
      console.error("ERROR:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);
