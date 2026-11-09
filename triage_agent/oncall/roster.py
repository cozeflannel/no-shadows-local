"""On-call roster resolution (shared by the agent and the Agent Console).

Resolution order (per the plan): active override -> weekly rotation ->
backup -> fallback. Backup/fallback are also the escalation chain when the
on-call person doesn't respond (see ReminderPolicy).
"""

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from ..models import OnCallResolution, Person, Roster, RotationSlot

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _hhmm(value: str) -> time:
    hours, minutes = value.strip().split(":")
    return time(int(hours), int(minutes))


def _local_dt(day: date, at: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, at, tzinfo=tz)


def slot_window(slot: RotationSlot, at: datetime) -> tuple[datetime, datetime] | None:
    """The slot occurrence containing `at` as (start_utc, end_utc), else None.

    Slots whose end <= start span midnight (e.g. 22:00-06:00); `days` refers
    to the day the shift starts.
    """
    tz = ZoneInfo(slot.tz)
    local = at.astimezone(tz)
    start_t, end_t = _hhmm(slot.start), _hhmm(slot.end)
    spans_midnight = end_t <= start_t
    today = WEEKDAYS[local.weekday()]

    if not spans_midnight:
        if today in slot.days and start_t <= local.time() < end_t:
            return (
                _local_dt(local.date(), start_t, tz).astimezone(timezone.utc),
                _local_dt(local.date(), end_t, tz).astimezone(timezone.utc),
            )
        return None

    # Overnight shift: started today, or started yesterday and still running.
    if today in slot.days and local.time() >= start_t:
        return (
            _local_dt(local.date(), start_t, tz).astimezone(timezone.utc),
            _local_dt(local.date() + timedelta(days=1), end_t, tz).astimezone(timezone.utc),
        )
    yesterday = WEEKDAYS[(local.weekday() - 1) % 7]
    if yesterday in slot.days and local.time() < end_t:
        return (
            _local_dt(local.date() - timedelta(days=1), start_t, tz).astimezone(timezone.utc),
            _local_dt(local.date(), end_t, tz).astimezone(timezone.utc),
        )
    return None


def person_by_id(roster: Roster, person_id: str | None) -> Person | None:
    if not person_id:
        return None
    if roster.fallback and roster.fallback.id == person_id:
        return roster.fallback
    return next((p for p in roster.people if p.id == person_id), None)


def person_by_email(roster: Roster, email: str | None) -> Person | None:
    if not email:
        return None
    email = email.strip().lower()
    candidates = list(roster.people) + ([roster.fallback] if roster.fallback else [])
    return next((p for p in candidates if p.email.lower() == email), None)


def person_by_name_or_email(roster: Roster, email: str | None, name: str | None = None) -> Person | None:
    by_email = person_by_email(roster, email)
    if by_email is not None:
        return by_email
    if not name:
        return None
    norm = " ".join(name.strip().lower().split())
    if not norm:
        return None
    candidates = list(roster.people) + ([roster.fallback] if roster.fallback else [])
    return next(
        (p for p in candidates
         if " ".join(p.name.strip().lower().split()) == norm
         or p.id.strip().lower() == norm),
        None,
    )


def person_for_sender(roster: Roster, email: str | None, name: str | None = None) -> Person | None:
    """The roster member behind a chat sender, for commands that change the roster.

    When the sender's email is known it alone decides (a display name must never grant
    membership to a different account). The name is consulted only when Studio exposed
    no email at all, which happens for external (agency) members.
    """
    if email and email.strip():
        return person_by_email(roster, email)
    return person_by_name_or_email(roster, None, name)


def resolve_on_call(roster: Roster, at: datetime) -> OnCallResolution:
    """Who should be @mentioned at `at` (timezone-aware datetime)."""
    if at.tzinfo is None:
        raise ValueError("resolve_on_call requires a timezone-aware datetime")
    people = {p.id: p for p in roster.people}

    # 1. Overrides (most recently created wins when they overlap)
    active = [o for o in roster.overrides if o.start <= at < o.end and o.person_id in people]
    if active:
        override = max(active, key=lambda o: o.created_at)
        return OnCallResolution(person=people[override.person_id], source="override", until=override.end)

    # 2. Weekly rotation (first matching slot wins)
    for slot in roster.rotation:
        window = slot_window(slot, at)
        if window and slot.person_id in people:
            return OnCallResolution(person=people[slot.person_id], source="rotation", until=window[1])

    # 3. Backup, then 4. fallback (nobody scheduled)
    backup = people.get(roster.backup_person_id or "")
    if backup:
        return OnCallResolution(person=backup, source="backup")
    if roster.fallback:
        return OnCallResolution(person=roster.fallback, source="fallback")
    return OnCallResolution(source="none")


def escalation_chain(roster: Roster, at: datetime) -> list[Person]:
    """Primary on-call, then backup, then fallback (deduplicated, in order)."""
    chain: list[Person] = []
    primary = resolve_on_call(roster, at).person
    for person in (primary, people_get(roster, roster.backup_person_id), roster.fallback):
        if person and all(p.email.lower() != person.email.lower() for p in chain):
            chain.append(person)
    return chain


def people_get(roster: Roster, person_id: str | None) -> Person | None:
    return next((p for p in roster.people if p.id == person_id), None) if person_id else None


def schedule(roster: Roster, start: datetime, end: datetime, step_minutes: int = 30) -> list[dict]:
    """Contiguous segments of who is on call in [start, end), for calendar views.

    Each segment: {"start", "end", "person_id", "name", "email", "source"}.
    """
    segments: list[dict] = []
    t = start
    step = timedelta(minutes=step_minutes)
    while t < end:
        res = resolve_on_call(roster, t)
        key = (res.person.id if res.person else None, res.source)
        if segments and (segments[-1]["person_id"], segments[-1]["source"]) == key:
            segments[-1]["end"] = min(t + step, end)
        else:
            segments.append(
                {
                    "start": t,
                    "end": min(t + step, end),
                    "person_id": key[0],
                    "name": res.person.name if res.person else None,
                    "email": res.person.email if res.person else None,
                    "source": res.source,
                }
            )
        t += step
    return segments


def coverage_gaps(roster: Roster, start: datetime, end: datetime, step_minutes: int = 30) -> list[tuple[datetime, datetime]]:
    """Windows with no override/rotation coverage (only backup/fallback would be pinged)."""
    return [
        (s["start"], s["end"])
        for s in schedule(roster, start, end, step_minutes)
        if s["source"] not in ("override", "rotation")
    ]
