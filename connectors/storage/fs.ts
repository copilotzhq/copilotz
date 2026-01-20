// Minimal filesystem storage connector for assets
// Deno-only implementation using std APIs

export type FsPath = string;

export interface FsConnector {
	ensureDir(path: FsPath): Promise<void>;
	writeFile(path: FsPath, data: Uint8Array): Promise<void>;
	readFile(path: FsPath): Promise<Uint8Array>;
	exists(path: FsPath): Promise<boolean>;
	remove(path: FsPath): Promise<void>;
	join(...parts: string[]): FsPath;
}

export function createFsConnector(rootDir: FsPath): FsConnector {
	// Normalize to an absolute root to avoid cwd-dependent path issues
	const toAbsolute = (p: string): string => {
		const raw = String(p || ".").replace(/\/+$/, "");
		// Unix absolute or Windows drive prefix
		if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
		const cwd = String(Deno.cwd() || ".").replace(/\/+$/, "");
		return `${cwd}/${raw}`.replace(/\/{2,}/g, "/");
	};

	const root = toAbsolute(rootDir);
	
	// Debug: log resolved root on creation (only in debug mode)
	try {
		if (Deno.env.get("COPILOTZ_DEBUG") === "1") {
			console.log(`[fs-connector] Resolved root: "${rootDir}" → "${root}"`);
		}
	} catch { /* ignore */ }

	const join = (...parts: string[]): FsPath => {
		const clean = parts.filter(Boolean).join("/");
		return `${root}/${clean}`.replace(/\/{2,}/g, "/");
	};

	const ensureDir = async (path: FsPath): Promise<void> => {
		try {
			await Deno.mkdir(path, { recursive: true });
		} catch {
			// ignore if exists or not creatable (will fail on write)
		}
	};

	const writeFile = async (path: FsPath, data: Uint8Array): Promise<void> => {
		const dir = path.replace(/\/[^/]+$/, "");
		await ensureDir(dir);
		await Deno.writeFile(path, data);
	};

	const readFile = async (path: FsPath): Promise<Uint8Array> => {
		return await Deno.readFile(path);
	};

	const exists = async (path: FsPath): Promise<boolean> => {
		try {
			const s = await Deno.stat(path);
			return s && (s.isFile || s.isDirectory);
		} catch {
			return false;
		}
	};

	const remove = async (path: FsPath): Promise<void> => {
		try {
			await Deno.remove(path);
		} catch {
			// ignore
		}
	};

	return { ensureDir, writeFile, readFile, exists, remove, join };
}


