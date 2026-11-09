# Regenerates docs/manifest.json, which the website reads, from each page's frontmatter (title,
# description, section, order). Also rewrites the chapter list of each track's index page
# (docs/<track>.md, under "## The chapters") from its chapters' frontmatter, when the track has
# chapters (docs/<track>/part-<n>-<name>/<chapter>.md). Run it from the repository's root, then
# `deno fmt docs`:
#
#   python3 scripts/docs-index.py && deno fmt docs
#
# A page is any Markdown file under docs/ with a `section` in its frontmatter; docs/_staging/ is
# never one. A section the list below doesn't name stops the script, so no page goes missing.
import glob, json, os, re, sys

SECTIONS = ["Getting Started", "Build Compass", "Guides", "Operations", "Reference", "Architecture"]
# The tracks whose chapters are listed on their index page, and shown as "Ch <n>: <title>".
TRACKS = {"Getting Started": "getting-started", "Build Compass": "build-compass"}
# Names that keep their capital at the start of a chapter's line in the list.
NAMES = {"North", "North's", "Compass", "Compass's", "Copilotz", "Copilotz's", "Ana", "Bruno"}


def frontmatter(path):
    text = open(path, encoding="utf-8").read()
    if not text.startswith("---\n"):
        return None
    block = text[4 : text.index("\n---\n", 4)]
    data = {}
    for line in block.split("\n"):
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not m:
            continue
        value = m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1].replace('\\"', '"')
        data[m.group(1)] = value
    return data


pages = {name: [] for name in SECTIONS}
for path in sorted(glob.glob("docs/**/*.md", recursive=True)):
    slug = path[len("docs/") : -len(".md")]
    if slug.startswith("_staging/") or slug.startswith("_"):
        continue
    data = frontmatter(path)
    if not data or "section" not in data:
        continue
    if data["section"] not in pages:
        sys.exit(f"{path}: section {data['section']!r} isn't one of {SECTIONS}")
    for key in ("title", "order"):
        if key not in data:
            sys.exit(f"{path}: frontmatter needs {key}")
    part = re.match(r"^[^/]+/part-(\d+)-([^/]+)/", slug)
    pages[data["section"]].append(
        {
            "part": (int(part.group(1)), part.group(2).replace("-", " ")) if part else None,
            "order": int(data["order"]),
            "title": data["title"],
            "description": data.get("description", ""),
            "slug": slug,
        }
    )

sections = []
for name in SECTIONS:
    entries = sorted(pages[name], key=lambda p: ((p["part"] or (0, ""))[0], p["order"], p["slug"]))
    items = []
    for p in entries:
        title = p["title"]
        chapter = re.match(r"Chapter (\d+): (.*)", title)
        if chapter:
            title = f"Ch {chapter.group(1)}: {chapter.group(2)}"
        item = {"title": title, "slug": p["slug"]}
        if p["description"]:
            item["description"] = p["description"]
        items.append(item)
    if items:
        sections.append({"title": name, "items": items})

    # The track's index page lists its chapters, by part, when it has any.
    track = TRACKS.get(name)
    chapters = [p for p in entries if p["part"]]
    index = f"docs/{track}.md" if track else None
    if not (index and chapters and os.path.exists(index)):
        continue
    lines = []
    current = None
    for p in chapters:
        if p["part"] != current:
            if current is not None:
                lines.append("")
            current = p["part"]
            lines.append(f"**Part {current[0]}: {current[1]}**\n")
        n, t = re.match(r"Chapter (\d+): (.*)", p["title"]).groups()
        desc = p["description"]
        first = re.split(r"[\s:,]", desc, maxsplit=1)[0] if desc else ""
        if desc and first not in NAMES and not first[1:2].isupper():
            desc = desc[0].lower() + desc[1:]
        lines.append(f"{n}. [{t}]({p['slug']}.md): {desc}")
    text = open(index, encoding="utf-8").read()
    if "## The chapters" not in text:
        sys.exit(f"{index}: needs a '## The chapters' heading for its list")
    head = text[: text.index("## The chapters")]
    open(index, "w", encoding="utf-8").write(head + "## The chapters\n\n" + "\n".join(lines) + "\n")

with open("docs/manifest.json", "w", encoding="utf-8") as out:
    json.dump({"sections": sections}, out, indent=2, ensure_ascii=False)
    out.write("\n")
print(", ".join(f"{s['title']}: {len(s['items'])}" for s in sections))
