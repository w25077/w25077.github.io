#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 Steam 游戏时长，生成 data/steam_games.json（页面同源读取）。

依赖：
  - 仓库 Secret：STEAM_API_KEY
      GitHub → Settings → Secrets and variables → Actions → New repository secret
      密钥在 steamcommunity.com/dev/apikey 免费申请（域名栏任意文本即可）。
  - Steam 账号需对 API 可见时长：个人资料公开，且隐私设置中
    「游戏详情」设为公开（否则接口返回 response: null 或空列表）。

数据源：Steam Web API
  IPlayerService/GetOwnedGames/v1（playtime_forever，单位：分钟）

输出 schema：
  {
    "steamid": "...", "generatedAt": "ISO-Z", "source": "steam-web-api",
    "totalGames": int,     # API 返回的游戏总数（含 0 时长）
    "totalHours": float,   # 所有游戏累计时长（h，含不足 1h 部分）
    "games": [ {"appid": int, "name": str, "hours": float,
                "minutes": int, "icon": str} ],   # 按时长降序，仅记录 ≥1h，最多 TOP 款
  }

退出码：成功 0；失败 1（失败时不覆盖旧快照）。
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

# SteamID64。账号资料链接形如 steamcommunity.com/profiles/76561198XXXXXXXXXX。
# 442654920 为 SteamID32，换算后为 76561198402920648；如与实际不符，改这里或设置环境变量 STEAM_ID64。
STEAM_ID = os.environ.get("STEAM_ID64") or "76561198402920648"
OUT = "data/steam_games.json"
TOP = 80              # 快照最多保留前 80 款（页面仅展示 Top 12）
MIN_MINUTES = 60      # 仅记录游玩 ≥ 1 小时的游戏
TIMEOUT = 25

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "application/json",
}


def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def save(snapshot):
    text = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n"
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    changed = True
    try:
        with open(OUT, "r", encoding="utf-8") as f:
            changed = f.read() != text
    except FileNotFoundError:
        pass
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    n = len(snapshot["games"])
    print(f"saved {OUT}: {n} entries, totalGames={snapshot['totalGames']}, "
          f"totalHours={snapshot['totalHours']}, changed={changed}")
    if changed:
        open("data/.changed", "w").close()
    return changed


def main():
    key = os.environ.get("STEAM_API_KEY")
    if not key:
        print("缺少 STEAM_API_KEY：请在仓库 Settings → Secrets → Actions 添加，"
              "再手动触发本工作流。", file=sys.stderr)
        return 1

    url = (
        "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/"
        "?key=%s&steamid=%s&include_appinfo=true"
        "&include_played_free_games=true&format=json" % (key, STEAM_ID)
    )
    try:
        payload = fetch_json(url)
        resp = payload.get("response")
        if resp is None:
            raise RuntimeError(
                "response 为空：资料可能未公开，或隐私设置中「游戏详情」不是公开")
        games = resp.get("games") or []
    except Exception as exc:  # noqa: BLE001
        print(f"steam fetch failed: {exc}", file=sys.stderr)
        return 1

    total_minutes = 0
    entries = []
    for g in games:
        minutes = int(g.get("playtime_forever") or 0)
        total_minutes += minutes
        if minutes < MIN_MINUTES:
            continue
        entries.append({
            "appid": int(g.get("appid") or 0),
            "name": (g.get("name") or "Unknown").strip(),
            "hours": round(minutes / 60.0, 1),
            "minutes": minutes,
            "icon": g.get("img_icon_url") or "",
        })

    entries.sort(key=lambda e: e["minutes"], reverse=True)
    entries = entries[:TOP]

    snapshot = {
        "steamid": STEAM_ID,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "source": "steam-web-api",
        "totalGames": len(games),
        "totalHours": round(total_minutes / 60.0, 1),
        "games": entries,
    }
    save(snapshot)
    print(f"done: {len(entries)} games with >= {MIN_MINUTES} min recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
