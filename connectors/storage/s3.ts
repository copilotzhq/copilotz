// Minimal S3-like storage connector (works with S3/MinIO or pre-signed gateways)
// This avoids heavy SDKs; callers can provide baseUrl or implement their own connector.

export interface S3PutObjectParams {
	bucket: string;
	key: string;
	body: Uint8Array;
	contentType?: string;
	url?: string; // optional fully-qualified URL (pre-signed PUT)
}

export interface S3GetObjectParams {
	bucket: string;
	key: string;
	url?: string; // optional fully-qualified URL (pre-signed GET)
}

export interface S3Connector {
	putObject(params: S3PutObjectParams): Promise<void>;
	getObject(params: S3GetObjectParams): Promise<{ body: Uint8Array; contentType?: string }>;
	getSignedUrl?(bucket: string, key: string, opts?: { expiresIn?: number; method?: "GET" | "PUT" }): Promise<string>;
	publicUrl?(bucket: string, key: string): string;
}

export function createS3Connector(baseUrl: string): S3Connector {
	const base = String(baseUrl || "").replace(/\/+$/, "");

	const toUrl = (bucket: string, key: string): string => {
		const k = String(key).replace(/^\/+/, "");
		return `${base}/${encodeURIComponent(bucket)}/${k}`;
	};

	const putObject: S3Connector["putObject"] = async (params) => {
		const url = params.url || toUrl(params.bucket, params.key);
		const res = await fetch(url, {
			method: "PUT",
			headers: {
				...(params.contentType ? { "Content-Type": params.contentType } : {}),
			},
			body: params.body,
		});
		if (!res.ok) {
			throw new Error(`S3 putObject failed: ${res.status} ${await safeText(res)}`);
		}
	};

	const getObject: S3Connector["getObject"] = async (params) => {
		const url = params.url || toUrl(params.bucket, params.key);
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(`S3 getObject failed: ${res.status} ${await safeText(res)}`);
		}
		const contentType = res.headers.get("content-type") || undefined;
		const buf = new Uint8Array(await res.arrayBuffer());
		return { body: buf, contentType };
	};

	const publicUrl = (bucket: string, key: string): string => toUrl(bucket, key);

	return { putObject, getObject, publicUrl };
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}


