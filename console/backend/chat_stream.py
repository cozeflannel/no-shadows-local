from fastapi import APIRouter, Query
from datetime import datetime, timezone

router = APIRouter(prefix="/api", tags=["chat"])

@router.get("/chat/stream")
def chat_stream(limit: int = Query(100, le=500)):
    # Temporary: return empty until agent events land.
    # Replace the body with a query against Firestore/BigQuery events + outbox.
    return {
        "messages": [],
        "as_of": datetime.now(timezone.utc).isoformat(),
    }
