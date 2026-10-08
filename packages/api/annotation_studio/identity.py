"""Request identity propagated from a trusted authentication proxy."""

from __future__ import annotations

from contextvars import ContextVar, Token

_OWNER: ContextVar[str] = ContextVar("annotation_studio_owner", default="local")


def current_owner() -> str:
    return _OWNER.get()


def set_current_owner(owner_id: str) -> Token[str]:
    return _OWNER.set(owner_id)


def reset_current_owner(token: Token[str]) -> None:
    _OWNER.reset(token)
