"""Phase 3: Views, Likes, Watchtime regelmäßig über die offiziellen APIs holen."""

from __future__ import annotations

import logging
from collections import defaultdict

from sqlalchemy import select

from ..db import Publication, SocialAccount, session_scope, utcnow
from ..publish.base import PublishError
from ..publish.registry import adapter_for, get_tokens

log = logging.getLogger(__name__)


def collect_all() -> int:
    with session_scope() as s:
        pubs = s.scalars(select(Publication).where(Publication.status.in_(("live", "processing")), Publication.external_id.is_not(None))).all()
        by_acc: dict[int, list[tuple[int, str]]] = defaultdict(list)
        for p in pubs:
            by_acc[p.account_id].append((p.id, p.external_id))
        accounts = {a.id: (a.platform, {"external_id": a.external_id, **(a.meta or {})}) for a in s.scalars(select(SocialAccount)).all()}
    updated = 0
    for aid, items in by_acc.items():
        if aid not in accounts:
            continue
        platform, meta = accounts[aid]
        try:
            adapter = adapter_for(platform)
            tokens = get_tokens(aid)
            # TikTok/Instagram: „processing“ prüfen und ggf. auf live setzen
            for pid, ext in items:
                res = adapter.check_status(tokens, meta, ext)
                if res is not None and res.status == "live":
                    with session_scope() as s:
                        p = s.get(Publication, pid)
                        if p.status == "processing":
                            p.status = "live"
                            p.external_id = res.external_id
                            p.external_url = res.url or p.external_url
            with session_scope() as s:
                items = [(p.id, p.external_id) for p in s.scalars(select(Publication).where(Publication.account_id == aid,
                         Publication.status == "live", Publication.external_id.is_not(None))).all()]
            metrics = adapter.fetch_metrics(tokens, meta, [e for _, e in items])
        except PublishError as exc:
            log.warning("Metriken für Konto %s nicht abrufbar: %s", aid, exc)
            continue
        with session_scope() as s:
            for pid, ext in items:
                if ext in metrics:
                    p = s.get(Publication, pid)
                    p.metrics = metrics[ext]
                    p.metrics_updated_at = utcnow()
                    updated += 1
    return updated
