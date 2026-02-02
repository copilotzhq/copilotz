import { S3Client, type S3ClientOptions } from "@bradenmacdonald/s3-lite-client";

// Minimal S3-like storage connector (works with S3/MinIO or pre-signed gateways)
// Uses s3-lite-client for authenticated requests when configured.

export interface S3ConnectionConfig {
	/**
	 * Base URL for simple (unsigned) GET/PUT requests.
	 * Example: "https://s3.amazonaws.com"
	 */
	baseUrl?: string;
	/**
	 * S3 endpoint for authenticated connections (full URL or hostname).
	 * Example: "https://s3.us-east-1.amazonaws.com" or "storage.googleapis.com"
	 */
	endpoint?: string;
	/**
	 * Alias for endpoint (matches s3-lite-client naming).
	 */
	endPoint?: string;
	/**
	 * Region for authenticated requests (required by s3-lite-client).
	 */
	region?: string;
	/**
	 * Access key (AWS-style) and secret key.
	 */
	accessKeyId?: string;
	secretAccessKey?: string;
	/**
	 * Access key and secret key (s3-lite-client style).
	 */
	accessKey?: string;
	secretKey?: string;
	/**
	 * Optional session token for temporary credentials.
	 */
	sessionToken?: string;
	/**
	 * Optional default bucket name for s3-lite-client.
	 */
	bucket?: string;
	/**
	 * Use path-style URLs (default: true in s3-lite-client).
	 */
	pathStyle?: boolean;
	/**
	 * Deprecated in s3-lite-client; only used when endpoint is not a full URL.
	 */
	useSSL?: boolean;
	port?: number;
	pathPrefix?: string;
}

export interface S3ConnectorConfig extends S3ConnectionConfig {
	/**
	 * Optional public base URL for GETs. If provided, publicUrl() will return `${publicBaseUrl}/{key}`.
	 * Include the bucket in this URL if your public endpoint requires it.
	 */
	publicBaseUrl?: string;
}

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

export function createS3Connector(baseUrlOrConfig: string | S3ConnectorConfig): S3Connector {
	const config: S3ConnectorConfig = typeof baseUrlOrConfig === "string"
		? { baseUrl: baseUrlOrConfig }
		: (baseUrlOrConfig ?? {});
	const baseUrl = normalizeBaseUrl(config.baseUrl ?? config.endpoint ?? config.endPoint);
	const publicBaseUrl = normalizeBaseUrl(config.publicBaseUrl);
	const endpoint = config.endPoint ?? config.endpoint ?? config.baseUrl ?? "";
	const wantsClient = Boolean(
		config.region ||
			config.accessKeyId ||
			config.secretAccessKey ||
			config.accessKey ||
			config.secretKey ||
			config.sessionToken ||
			config.pathStyle ||
			config.useSSL ||
			config.port ||
			config.pathPrefix,
	);

	const client = wantsClient ? createS3Client(config, endpoint) : undefined;

	const toUrl = (bucket: string, key: string, base: string): string => {
		const k = String(key).replace(/^\/+/, "");
		return joinUrl(base, encodeURIComponent(bucket), k);
	};

	const putObject: S3Connector["putObject"] = async (params) => {
		if (params.url) {
			await putViaFetch(params.url, params);
			return;
		}
		if (client) {
			await putViaClient(client, params);
			return;
		}
		if (!baseUrl) {
			throw new Error("S3 connector requires baseUrl/endpoint for unsigned requests.");
		}
		await putViaFetch(toUrl(params.bucket, params.key, baseUrl), params);
	};

	const getObject: S3Connector["getObject"] = async (params) => {
		if (params.url) {
			return await getViaFetch(params.url);
		}
		if (client) {
			return await getViaClient(client, params);
		}
		if (!baseUrl) {
			throw new Error("S3 connector requires baseUrl/endpoint for unsigned requests.");
		}
		return await getViaFetch(toUrl(params.bucket, params.key, baseUrl));
	};

	const getSignedUrl = client
		? async (bucket: string, key: string, opts?: { expiresIn?: number; method?: "GET" | "PUT" }) => {
			const method = opts?.method ?? "GET";
			const expiresIn = opts?.expiresIn;
			return await client.getPresignedUrl(method, key, {
				bucketName: bucket,
				...(typeof expiresIn === "number" ? { expirySeconds: expiresIn } : {}),
			});
		}
		: undefined;

	const publicUrl = (() => {
		if (publicBaseUrl) {
			return (_bucket: string, key: string): string => joinUrl(publicBaseUrl, key);
		}
		if (client) {
			return (bucket: string, key: string): string => {
				const base = buildClientBaseUrl(client, bucket);
				return client.pathStyle ? joinUrl(base, bucket, key) : joinUrl(base, key);
			};
		}
		if (baseUrl) {
			return (bucket: string, key: string): string => toUrl(bucket, key, baseUrl);
		}
		return undefined;
	})();

	return {
		putObject,
		getObject,
		...(getSignedUrl ? { getSignedUrl } : {}),
		...(publicUrl ? { publicUrl } : {}),
	};
}

function createS3Client(config: S3ConnectorConfig, endpoint: string): S3Client {
	if (!endpoint) {
		throw new Error("S3 connector requires endpoint when using authenticated requests.");
	}
	if (!config.region) {
		throw new Error("S3 connector requires region when using authenticated requests.");
	}
	const accessKey = config.accessKey ?? config.accessKeyId;
	const secretKey = config.secretKey ?? config.secretAccessKey;
	const isUrl = /^https?:\/\//i.test(endpoint);
	const options: S3ClientOptions = {
		endPoint: endpoint,
		region: config.region,
		accessKey,
		secretKey,
		sessionToken: config.sessionToken,
		bucket: config.bucket,
		pathStyle: config.pathStyle,
	};
	if (!isUrl) {
		if (config.useSSL !== undefined) options.useSSL = config.useSSL;
		if (config.port !== undefined) options.port = config.port;
		if (config.pathPrefix !== undefined) options.pathPrefix = config.pathPrefix;
	}
	return new S3Client(options);
}

async function putViaClient(client: S3Client, params: S3PutObjectParams): Promise<void> {
	const metadata = params.contentType ? { "Content-Type": params.contentType } : undefined;
	await client.putObject(params.key, params.body, {
		bucketName: params.bucket,
		...(metadata ? { metadata } : {}),
	});
}

async function getViaClient(
	client: S3Client,
	params: S3GetObjectParams,
): Promise<{ body: Uint8Array; contentType?: string }> {
	const res = await client.getObject(params.key, { bucketName: params.bucket });
	const contentType = res.headers.get("content-type") || undefined;
	const buf = new Uint8Array(await res.arrayBuffer());
	return { body: buf, contentType };
}

async function putViaFetch(url: string, params: S3PutObjectParams): Promise<void> {
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
}

async function getViaFetch(url: string): Promise<{ body: Uint8Array; contentType?: string }> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`S3 getObject failed: ${res.status} ${await safeText(res)}`);
	}
	const contentType = res.headers.get("content-type") || undefined;
	const buf = new Uint8Array(await res.arrayBuffer());
	return { body: buf, contentType };
}

function buildClientBaseUrl(client: S3Client, bucket: string): string {
	const host = client.pathStyle ? client.host : `${bucket}.${client.host}`;
	const prefix = client.pathPrefix || "";
	return `${client.protocol}//${host}${prefix}`;
}

function normalizeBaseUrl(value?: string): string | undefined {
	const base = typeof value === "string" ? value.trim() : "";
	if (!base) return undefined;
	return base.replace(/\/+$/, "");
}

function joinUrl(base: string, ...parts: string[]): string {
	const cleanBase = base.replace(/\/+$/, "");
	const cleanParts = parts.filter(Boolean).map((part) => String(part).replace(/^\/+/, ""));
	return [cleanBase, ...cleanParts].join("/");
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}


