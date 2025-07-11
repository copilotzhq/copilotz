import type { DocumentExtractor, ExtractorConfig, ExtractionRequest, ExtractionResult, DocumentType } from '../../types.ts';

export class JsonExtractor implements DocumentExtractor {
  name = 'json' as const;
  supportedTypes: DocumentType[] = ['json'];
  constructor(private config: ExtractorConfig) {}
  
  validate(source: any): boolean {
    switch (source.type) {
      case 'file': return source.file?.type === 'application/json' || source.fileName?.toLowerCase().endsWith('.json');
      case 'url': return source.url.toLowerCase().endsWith('.json');
      case 'base64': return source.mimeType === 'application/json';
      case 'text': return true; // Can try to parse any text as JSON
      default: return false;
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    return { success: false, error: 'JSON parsing not yet implemented.', processingTime: 0 };
  }
}

export function createJsonExtractor(config: ExtractorConfig): JsonExtractor {
  return new JsonExtractor(config);
} 