# Skill declaration

`defineSkill` accepts a root path or URL, inline Markdown, or a packaged
manifest with a lazy file reader. It contributes the shared Skills support
plugin automatically and performs no I/O at declaration. Root manifests load
lazily and must match the resource alias.
