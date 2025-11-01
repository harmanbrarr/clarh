from fastapi import FastAPI
from pydantic import BaseModel
from sqlmodel import SQLModel, Field, create_engine, Session, select
from typing import List, Optional
import os
import openai
from datetime import datetime
import dateparser
import json
import re

# make sure to set in environment first 
# setx OPENAI_API_KEY "YOUR_API_KEY_HERE"
openai.api_key = os.getenv("OPENAI_API_KEY")  

#defines what we'll store in sql db for each entry
class EntryDB(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    text: str
    type: str
    datetime: Optional[str] = None
    event_name: Optional[str] = None
    location: Optional[str] = None
    readable_datetime: Optional[str] = None #just use friendly readable datetime


#define setup for app and storage
app = FastAPI()
engine = create_engine("sqlite:///database.db")  
SQLModel.metadata.create_all(engine)  # create tables if they don't exist

#input layout
class Entry(BaseModel):
    text: str
#extract the important info from the inputted info 
# prompt we want to send to openai
def extract_event_info(text: str):
    """
    Sends user text to OpenAI to classify it as Task, Event, or Note,
    and extract event_name, location, datetime, and readable_datetime.
    Returns structured dict. Compatible with openai>=1.0.0 (2.x).
    """
    prompt = f"""
You are an assistant that classifies human text into Tasks, Events, or Notes.
Rules:
1. Task: Something the user needs to do (may or may not have a datetime)
2. Event: Something that happens at a specific time and/or location
3. Note: Any other text that is just information or a reminder

For Events and Tasks, extract the datetime and location if mentioned. Also provide a human-readable datetime.

Return JSON ONLY with these fields:
{{"type":"", "event_name":"", "location":"", "datetime":"", "readable_datetime":""}}

- type: Task / Event / Note
- event_name: Name of the event/task (use text itself if name is not clear)
- location: If location is mentioned, else null
- datetime: If datetime is mentioned, convert to ISO format if possible, else null
- readable_datetime: Friendly human-readable format like "Tuesday, Oct 3 at 3:00 PM", else null

Text: "{text}"
"""

    try:
        response = openai.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt}
            ],
            temperature=0
        )

        content = response.choices[0].message.content.strip()

        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if match:
                data = json.loads(match.group())
            else:
                raise

        # Safety defaults
        data.setdefault("type", "Note")
        data.setdefault("event_name", text)
        data.setdefault("location", None)
        data.setdefault("datetime", None)
        data.setdefault("readable_datetime", None)

        # --- Validation & fallback ---
        parsed = None
        if data.get("datetime"):
            parsed = dateparser.parse(data["datetime"])

        if parsed:
            # Always normalize datetime to ISO
            data["datetime"] = parsed.isoformat()

            # If GPT didn’t give a readable_datetime or it looks invalid, create one
            if not data.get("readable_datetime") or len(data["readable_datetime"]) < 5:
                data["readable_datetime"] = parsed.strftime("%A, %b %d at %I:%M %p")
        else:
            # No valid datetime → wipe datetime and readable_datetime
            data["datetime"] = None
            data["readable_datetime"] = None

        return data

    except Exception as e:
        print("OpenAI parsing error:", e)
        return {
            "type": "Note",
            "event_name": text,
            "location": None,
            "datetime": None,
            "readable_datetime": None
        }


#ouput format
def output_format(e: EntryDB):
    return {
        "id": e.id,
        "text": e.text,
        "type": e.type,
        "datetime": e.datetime,
        "readable_datetime": e.readable_datetime,  
        "event_name": e.event_name,
        "location": e.location
    }


# group and sort the enteries for when its needed for frontend
def get_grouped_entries():
    with Session(engine) as session:
        entries = session.exec(select(EntryDB)).all()

    # separate by type
    tasks = [e for e in entries if e.type == "Task"]
    events = [e for e in entries if e.type == "Event"]
    notes = [e for e in entries if e.type == "Note"]

    # sort tasks: datetime first, unscheduled last
    tasks_sorted = sorted(
        tasks, 
        key=lambda t: t.datetime if t.datetime != "unscheduled" else "9999-12-31T23:59:59"
    )

    # sort events by datetime
    events_sorted = sorted(events, key=lambda e: e.datetime or "9999-12-31T23:59:59")

    return {
        "Tasks": [output_format(e) for e in tasks_sorted],
        "Events": [output_format(e) for e in events_sorted],
        "Notes": [output_format(e) for e in notes]
    }


#classification
@app.post("/classify")
def classify_entry(entry: Entry):
    data = extract_event_info(entry.text)

    # If it's a task without a datetime, mark as unscheduled
    if data["type"] == "Task" and not data.get("datetime"):
        data["datetime"] = "unscheduled"
        data["readable_datetime"] = "unscheduled"

    with Session(engine) as session:
        db_entry = EntryDB(
            text=entry.text,
            type=data["type"],
            datetime=data.get("datetime"),
            readable_datetime=data.get("readable_datetime"),
            event_name=data.get("event_name"),
            location=data.get("location")
        )
        session.add(db_entry)
        session.commit()
        session.refresh(db_entry)

    # Return the grouped/sorted JSON 
    return get_grouped_entries()


#get the output from memories
@app.get("/entries")
def get_entries():
    return get_grouped_entries()