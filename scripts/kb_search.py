#!/usr/bin/env python3
"""Query the online knowledge-space Search API.

Usage:
  export KB_API_BASE="https://your-worker.workers.dev"
  export KB_API_TOKEN="your-token"
  python3 scripts/kb_search.py "AI Agent 知识库" --top-k 5
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("query", help="search query")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    args = parser.parse_args()

    base = os.environ.get("KB_API_BASE", "").rstrip("/")
    token = os.environ.get("KB_API_TOKEN", "")
    if not base or not token:
        print("Missing KB_API_BASE or KB_API_TOKEN", file=sys.stderr)
        return 2

    url = f"{base}/search?q={urllib.parse.quote(args.query)}&top_k={args.top_k}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        print(f"Search failed: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    print(f"# 知识库检索：{args.query}\n")
    results = data.get("results", [])
    if not results:
        print("未找到相关结果。")
        return 0

    for i, item in enumerate(results, 1):
        print(f"## {i}. {item.get('title') or '未命名'}")
        if item.get("score") is not None:
            print(f"- Score: {item['score']}")
        if item.get("summary"):
            print(f"- 摘要：{item['summary']}")
        if item.get("snippet"):
            snippet = str(item["snippet"]).replace("\n", " ")[:500]
            print(f"- 片段：{snippet}")
        if item.get("tags"):
            print(f"- 标签：{', '.join(item['tags'])}")
        if item.get("source_url"):
            print(f"- 原链接：{item['source_url']}")
        if item.get("notion_page_url"):
            print(f"- Notion：{item['notion_page_url']}")
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
