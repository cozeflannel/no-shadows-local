"""Config keys the models don't know fail the load and the Generated.gs build (triage_agent/config.py ConfigModel).

pydantic used to drop them without a word: an unquoted comma in a YAML flow mapping cut the live Gemini check
issue_name_neutral to "The issue name must describe the issue accurately", and nothing failed.
"""

from __future__ import annotations

import inspect
import logging
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from scripts import build_apps_script
from triage_agent import config as config_module
from triage_agent.config import AgentConfig, load_config, load_default_dict

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "apps-script-chat-bot" / "Generated.gs"
NEUTRAL = "The issue name must describe the issue accurately, descriptively and neutrally."

# An unquoted comma inside {...}: YAML reads instruction "The issue name must be accurate" plus a stray key.
COMMA_YAML = """\
alert_template:
  llm_checks:
    - {id: issue_name_neutral, correctable_field: issue_name, severity: warning, fields: [issue_name],
       instruction: The issue name must be accurate, descriptive and neutral.}
"""
STRAY = ("alert_template", "llm_checks", "0", "descriptive and neutral.")


class _Store:
    def __init__(self, overrides):
        self.overrides = overrides

    def get_config_overrides(self):
        return self.overrides


def _yaml(tmp_path: Path, monkeypatch, text: str, name: str = "a") -> Path:
    """A config YAML of its own (load_default_dict caches by path, so each text gets its own folder)."""
    folder = tmp_path / name
    folder.mkdir()
    path = folder / "default_config.yaml"
    path.write_text(text, encoding="utf-8")
    monkeypatch.delenv("TRIAGE_DISTRIBUTION_PATH", raising=False)
    monkeypatch.delenv("TRIAGE_ENV", raising=False)
    return path


def _locs(exc: pytest.ExceptionInfo) -> list[tuple[str, ...]]:
    return [tuple(str(p) for p in e["loc"]) for e in exc.value.errors()]


def test_every_config_model_refuses_unknown_keys():
    models = [cls for _, cls in inspect.getmembers(config_module, inspect.isclass)
              if issubclass(cls, BaseModel) and cls.__module__ == config_module.__name__]
    assert len(models) > 40
    assert [cls.__name__ for cls in models if cls.model_config.get("extra") != "forbid"] == []


def test_shipped_config_keeps_the_full_text_of_both_quoted_values():
    cfg = load_config()
    check = next(c for c in cfg.alert_template.llm_checks if c.id == "issue_name_neutral")
    assert check.instruction == NEUTRAL
    assert cfg.alert_template.field("issue_name").description == "Descriptive, neutral issue name."
    # What the bot's Gemini review is given (Review.gs assessPrompts_ reads GEN.llm_checks)
    assert f'"instruction": "{NEUTRAL}"' in GENERATED.read_text(encoding="utf-8")


def test_an_unquoted_comma_in_the_yaml_fails_the_load(tmp_path, monkeypatch):
    with pytest.raises(ValidationError) as exc:
        load_config(path=_yaml(tmp_path, monkeypatch, COMMA_YAML))
    assert _locs(exc) == [STRAY]
    assert exc.value.errors()[0]["type"] == "extra_forbidden"

    quoted = COMMA_YAML.replace("instruction: The issue name must be accurate, descriptive and neutral.",
                                'instruction: "The issue name must be accurate, descriptive and neutral."')
    cfg = load_config(path=_yaml(tmp_path, monkeypatch, quoted, name="quoted"))
    assert cfg.alert_template.llm_checks[0].instruction == "The issue name must be accurate, descriptive and neutral."


def test_a_dropped_key_fails_the_generated_gs_build(tmp_path, monkeypatch):
    monkeypatch.setenv("TRIAGE_CONFIG_PATH", str(_yaml(tmp_path, monkeypatch, COMMA_YAML)))
    with pytest.raises(ValidationError) as exc:
        build_apps_script.main(["--check"])  # fails in load_config, before it compares or writes anything
    assert _locs(exc) == [STRAY]


def test_a_typo_anywhere_fails_validation():
    data = load_default_dict()
    data["burson_qa"]["kof_no_alert_judgement"] = True  # misspelled: used to do nothing at all
    data["alert_template"]["fields"][0]["descripton"] = "x"
    data["thresholdz"] = {}
    with pytest.raises(ValidationError) as exc:
        AgentConfig.model_validate(data)
    assert sorted(_locs(exc)) == sorted([("burson_qa", "kof_no_alert_judgement"),
                                         ("alert_template", "fields", "0", "descripton"), ("thresholdz",)])


def test_a_saved_setting_this_version_no_longer_knows_is_ignored_with_a_warning(caplog, monkeypatch):
    monkeypatch.delenv("TRIAGE_ENV", raising=False)
    with caplog.at_level(logging.WARNING, logger="triage_agent.config"):
        cfg = load_config(_Store({"burson_qa": {"react": False, "retired_setting": 3}}))
    assert cfg.burson_qa.react is False  # the rest of the saved override still applies
    assert "burson_qa.retired_setting" in caplog.text


def test_a_saved_setting_with_a_bad_value_still_fails(monkeypatch):
    monkeypatch.delenv("TRIAGE_ENV", raising=False)
    with pytest.raises(ValidationError):
        load_config(_Store({"burson_qa": {"react": "sometimes", "retired_setting": 3}}))


def test_a_stray_yaml_key_fails_even_with_saved_overrides(tmp_path, monkeypatch):
    path = _yaml(tmp_path, monkeypatch, COMMA_YAML)
    with pytest.raises(ValidationError) as exc:
        load_config(_Store({"burson_qa": {"retired_setting": 3}}), path=path)
    assert _locs(exc) == [STRAY]
