#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 GitHub 贡献数据，生成 data/contributions.json（页面同源读取）。

数据源依次尝试（Actions 运行于 GitHub 美国服务器，均可访问）：
  1. GitHub 官方 GraphQL api.github.com/graphql（需 GH_TOKEN；Actions 内置 token）
     查 contributionsCollection.contributionCalendar：
     返回逐日精确 contributionCount + level，不依赖第三方与页面结构
  2. https://github-contributions-api.jogruber.de/v4/user/<user>   （可能已下线）
  3. https://api.github-contributions.vercel.app/api/<user>          （可能已下线）
  4. https://github-contributions.vercel.app/api/<user>
  5. https://github.com/users/<user>/contributions                   （官方 HTML，兜底）
     解析 data-date + data-level/data-score（每格等级）；
     注意：GitHub 改版后该页可能不再携带逐日次数（仅总数），
     此时 counts=false，页面统计为 0 —— 因此 GraphQL 为推荐主源。

输出 schema：
  {
    "user": ..., "generatedAt": ..., "source": "...",
    "lastYearTotal": int|null,        # 官方“近一年总数”（可取到时提供）
    "counts": bool,                   # 每格是否含具体次数
    "contributions": [ {"date": "YYYY-MM-DD", "count": N} | {"date":..., "level": L} ]
  }

退出码：任一源成功 0；全部失败 1。
诊断信息打印到 stdout/stderr，便于排查解析问题。
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

USER = "w25077"
OUT = "data/contributions.json"
KEEP_DAYS = 400  # 比页面 53 周窗口略宽
TIMEOUT = 20

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/json,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

JSON_SOURCES = [
    ("jogruber", "https://github-contributions-api.jogruber.de/v4/user/" + USER),
    ("vercel-a", "https://api.github-contributions.vercel.app/api/" + USER),
    ("vercel-b", "https://github-contributions.vercel.app/api/" + USER),
]
HTML_SOURCE = ("github-html", "https://github.com/users/" + USER + "/contributions")

# 官方 GraphQL：逐日精确次数（首选，需 GH_TOKEN / GITHUB_TOKEN）
GRAPHQL_SOURCE = ("graphql", "https://api.github.com/graphql")
GRAPHQL_QUERY = """query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays { date contributionCount color }
        }
      }
    }
  }
}"""
# GraphQL 无 level 字段，仅有 color（浅色/深色两套 GitHub 官方色板）→ 反查等级
COLOR_RANK = {
    # 深色主题（页面的色板）
    "#161B22": 0, "#0E4429": 1, "#006D32": 2, "#26A641": 3, "#39D353": 4,
    # 浅色主题
    "#EBEDF0": 0, "#9BE9A8": 1, "#40C463": 2, "#30A14E": 3, "#216E39": 4,
}
GRAPHQL_WINDOW_DAYS = (KEEP_DAYS, 366)  # 400 天窗口若被 API 拒绝则自动降级


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
    for enc in ("utf-8", "utf-8-sig"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def fetch_json(url):
    return json.loads(fetch(url))


def level_of_count(count):
    """按次数近似 GitHub 四档等级（接口缺 level 时用）。"""
    if count <= 0:
        return 0
    if count <= 3:
        return 1
    if count <= 6:
        return 2
    if count <= 9:
        return 3
    return 4


def graphql_call(token, variables):
    body = json.dumps({"query": GRAPHQL_QUERY, "variables": variables}).encode("utf-8")
    headers = dict(HEADERS)
    headers.update({
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
    })
    req = urllib.request.Request(GRAPHQL_SOURCE[1], data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("errors"):
        msgs = "; ".join(e.get("message", "?") for e in payload["errors"])
        raise RuntimeError("graphql errors: " + msgs)
    return payload["data"]


def fetch_graphql(token):
    """官方 GraphQL 贡献日历 → ({date: {date, level, count}}, total)。

    窗口过长时 API 可能拒绝，按 GRAPHQL_WINDOW_DAYS 逐级降级重试；
    全部失败则抛出异常交由 main() 走下一数据源。
    """
    last_exc = None
    for days in GRAPHQL_WINDOW_DAYS:
        now = datetime.now(timezone.utc)
        since = (now - timedelta(days=days)).date().isoformat()
        to = now.isoformat(timespec="seconds").replace("+00:00", "Z")
        try:
            data = graphql_call(token, {
                "login": USER,
                "from": since + "T00:00:00Z",
                "to": to,
            })
            cal = data["user"]["contributionsCollection"]["contributionCalendar"]
            by_date = {}
            for week in cal.get("weeks", []):
                for d in week.get("contributionDays", []):
                    date = str(d.get("date") or "")[:10]
                    if len(date) != 10 or not re.match(r"^20\d\d-\d\d-\d\d$", date):
                        continue
                    try:
                        count = max(0, int(round(float(d.get("contributionCount") or 0))))
                    except (TypeError, ValueError):
                        count = 0
                    rank = COLOR_RANK.get(str(d.get("color") or "").upper(), level_of_count(count))
                    by_date[date] = {"date": date, "level": rank, "count": count}
            if not by_date:
                raise RuntimeError("no contribution days in response")
            total = int(cal.get("totalContributions") or 0)
            print(f"[graphql] days={len(by_date)} total={total} window={days}d counts=True")
            return by_date, total
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            print(f"[graphql] window={days}d failed: {exc}", file=sys.stderr)
    raise last_exc or RuntimeError("graphql failed")


def flatten_json(payload):
    """兼容按年分组 / 平铺两类 JSON 形态 → [{date, count}]"""
    raw = payload.get("contributions") if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        return []
    days = []
    for item in raw:
        if isinstance(item, dict) and isinstance(item.get("contributions"), list):
            days.extend(item["contributions"])
        elif isinstance(item, dict):
            days.append(item)
    out = []
    for d in days:
        date = str(d.get("date") or "")[:10]
        if len(date) != 10 or not re.match(r"^20\d\d-\d\d-\d\d$", date):
            continue
        try:
            count = max(0, int(round(float(d.get("count") or 0))))
        except (TypeError, ValueError):
            continue
        if count > 0:
            out.append({"date": date, "count": count})
    return out


LEVEL_WORDS = {0: "no", 1: "low", 2: "mid", 3: "high", 4: "very-high"}


def parse_github_html(html):
    """解析官方贡献页 HTML：data-date + data-level/data-score，尽力取次数。"""
    cells = []
    tag_re = re.compile(r"<(?:td|rect)\b[^>]*>", re.I)

    for m in tag_re.finditer(html):
        tag = m.group(0)
        dm = re.search(r'data-date="(\d{4}-\d{2}-\d{2})"', tag)
        if not dm:
            continue
        date = dm.group(1)
        lm = re.search(r'data-(?:level|score)="([0-4])"', tag)
        if not lm:
            continue
        level = int(lm.group(1))
        count = None
        cm = re.search(r'data-count="(\d+)"', tag)
        if cm:
            count = int(cm.group(1))
        else:
            am = re.search(r'aria-label="([^"]*?)([\d,]+)\s+contributions?', tag)
            if am:
                count = int(am.group(2).replace(",", ""))
        cells.append({"date": date, "level": level, "count": count})

    # 汇总去重（同一天可能多格）
    by_date = {}
    for c in cells:
        prev = by_date.get(c["date"])
        if prev is None:
            by_date[c["date"]] = c
        elif prev.get("count") is None and c["count"] is not None:
            by_date[c["date"]] = c

    # 官方近一年总数（标题/无障碍文本中）
    total = None
    tm = re.search(r"([\d,]+)\s+contributions?\s+in the last year", html, re.I)
    if tm:
        total = int(tm.group(1).replace(",", ""))

    has_counts = any(c["count"] is not None for c in by_date.values())
    has_levels = len(by_date) > 0
    print(f"[github-html] cells={len(cells)} days={len(by_date)} levels={has_levels} "
          f"counts={has_counts} lastYearTotal={total}")
    if not has_levels:
        i = html.find("data-date")
        sample = html[i - 200:i + 400] if i >= 0 else html[:400]
        print("[github-html] no parsable cells; html sample follows:\n" + sample)
    return by_date, total, has_counts


def to_snapshot(days_by_date, total, has_counts, source):
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=KEEP_DAYS)).isoformat()
    entries = []
    for c in days_by_date.values():
        if c["date"] < cutoff:
            continue
        entry = {"date": c["date"]}
        if c.get("count") is not None:
            entry["count"] = c["count"]     # 含 0：GraphQL 源为逐日精确次数
        if c.get("level") is not None:
            entry["level"] = c["level"]     # 等级与次数可并存，页面优先用等级
        entries.append(entry)
    entries.sort(key=lambda d: d["date"])
    return {
        "user": USER,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": source,
        "lastYearTotal": total,
        "counts": has_counts,
        "contributions": entries,
    }


def save(snapshot):
    text = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n"
    # Actions 首次运行时仓库可能还没有 data/ 目录，先确保存在
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    changed = True
    try:
        with open(OUT, "r", encoding="utf-8") as f:
            changed = f.read() != text
    except FileNotFoundError:
        pass
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    n = len(snapshot["contributions"])
    print(f"saved {OUT}: {n} entries, counts={snapshot['counts']}, "
          f"lastYearTotal={snapshot['lastYearTotal']}, source={snapshot['source']}, changed={changed}")
    if changed:
        open("data/.changed", "w").close()
    return changed


def main():
    # 1) 官方 GraphQL（逐日精确次数；Actions 内置 token 即够用）
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        try:
            by_date, total = fetch_graphql(token)
            save(to_snapshot(by_date, total, True, GRAPHQL_SOURCE[0]))
            return 0
        except Exception as exc:  # noqa: BLE001
            print(f"[{GRAPHQL_SOURCE[0]}] failed: {exc}", file=sys.stderr)
    else:
        print("[graphql] no GH_TOKEN/GITHUB_TOKEN env, skip", file=sys.stderr)

    # 2) 第三方 JSON 接口（次数完整，可能已下线）
    for name, url in JSON_SOURCES:
        try:
            payload = fetch_json(url)
            days = flatten_json(payload)
            if not days:
                print(f"[{name}] payload empty, try next", file=sys.stderr)
                continue
            by_date = {d["date"]: {"date": d["date"], "level": None, "count": d["count"]} for d in days}
            snap = to_snapshot(by_date, None, True, name)
            save(snap)
            return 0
        except Exception as exc:  # noqa: BLE001
            print(f"[{name}] failed: {exc}", file=sys.stderr)

    # 3) 官方 HTML（兜底，通常可达；可能缺逐日次数）
    try:
        html = fetch(HTML_SOURCE[1])
        print(f"[github-html] fetched {len(html)} chars")
        by_date, total, has_counts = parse_github_html(html)
        if not by_date:
            raise RuntimeError("github-html parse yielded no cells")
        snap = to_snapshot(by_date, total, has_counts, HTML_SOURCE[0])
        save(snap)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"[{HTML_SOURCE[0]}] failed: {exc}", file=sys.stderr)

    print("ALL SOURCES FAILED - snapshot not updated", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
