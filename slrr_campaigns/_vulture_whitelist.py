"""Framework reflection references (logging.Formatter, Pydantic BaseModel) for vulture."""

from __future__ import annotations

from pydantic import BaseModel

from .logging_utils import StructuredJsonFormatter
from .models import CustomAlertPayload

_FORMAT_HOOK = StructuredJsonFormatter.format
_PYDANTIC_CONFIG = BaseModel.model_config
_VALIDATOR_HOOK = CustomAlertPayload._validate_recipients
