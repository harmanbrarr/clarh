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

      // ✅ Eastern reference time (America/Toronto)
      const easternNow = new Date().toLocaleString("sv-SE", {
        timeZone: "America/Toronto",
      });

      const systemPrompt = `
You are a strict classifier and date parser for a productivity app.

Your job is to analyze the user’s input and return EXACTLY ONE JSON object
representing a Task, Event, or Note.

You MUST follow all rules below.

────────────────────────────────
REFERENCE TIME (EASTERN)
────────────────────────────────
Current reference datetime (America/Toronto):
"${easternNow}"

Use this to interpret:
- today
- tomorrow
- later today
- next week
- this Friday
- in 2 hours

ALL dates and times MUST be calculated in America/Toronto time.

────────────────────────────────
TYPE DEFINITIONS
────────────────────────────────

TASK:
An action the user must do.

Examples:
- "buy groceries tomorrow"
- "clean room"
- "submit assignment Friday"

Rules:
- due_date = ISO DATE (YYYY-MM-DD)
- datetime = ISO DATETIME at START OF DAY (00:00 Eastern) for that date
- readable_datetime = friendly date (e.g. "Sun, Dec 14")
- If NO date mentioned:
  - due_date = null
  - datetime = null
  - readable_datetime = "unscheduled"

EVENT:
Something that happens at a specific time OR location.

Examples:
- "dentist appointment tomorrow at 3pm"
- "dinner with John at 7pm"
- "meeting at Starbucks"

Rules:
- datetime REQUIRED (ISO, Eastern)
- readable_datetime REQUIRED
- due_date MUST be null

NOTE:
Informational only.

Rules:
- due_date = null
- datetime = null
- readable_datetime = null
- location = null

────────────────────────────────
LOCATION EXTRACTION RULES
────────────────────────────────
You MUST extract a location if ANY place is mentioned.

Valid locations include:
- Businesses: "Walmart", "Starbucks", "Costco"
- Landmarks: "City Hall", "the mall", "the airport"
- Home references: "mom's house", "my place", "home"
- Proper nouns used as places: "Yorkdale", "Eaton Centre"
- Full addresses: "123 Main St"
- Anything following:
  "at", "in", "to", "from", "near", "by", "around", "inside", "outside"

Examples:
"drop off mom at Walmart tomorrow" → location = "Walmart"
"dentist appointment at 3pm" → location = "dentist"
"go to mom's house" → location = "mom's house"

If NO location exists → location = null  
Never guess.

────────────────────────────────
DATETIME PARSING RULES
────────────────────────────────
You MUST parse natural language dates such as:
- "tomorrow"
- "next week"
- "in two hours"
- "friday at 3pm"
- "april 6"
- "later today"

Output formats:
- datetime → ISO string (Eastern)
- readable_datetime → human friendly:
  - "Tomorrow"
  - "Tomorrow at 3 PM"
  - "Fri, Apr 6"
  - "Today at 5 PM"

────────────────────────────────
NAMING RULES
────────────────────────────────
- task_name → 2–4 word action
- event_name → short title
- note_title → 1–3 word topic

────────────────────────────────
FINAL ENFORCEMENT
────────────────────────────────
- Task → datetime is start-of-day only (no time)
- Event → due_date MUST be null
- Note → ALL date fields MUST be null
- Return ONLY valid JSON

────────────────────────────────
OUTPUT JSON (STRICT)
────────────────────────────────

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

      // Safety fallbacks
      data.original_text = inputText;
      if (!data.type) data.type = "Note";
      if (!("location" in data)) data.location = null;

      if (data.type === "Task") {
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
