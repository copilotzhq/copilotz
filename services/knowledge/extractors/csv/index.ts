import type { DocumentExtractor, ExtractorConfig, ExtractionRequest, ExtractionResult, DocumentType } from '../../types.ts';

export class CsvExtractor implements DocumentExtractor {
  name = 'csv' as const;
  supportedTypes: DocumentType[] = ['csv'];
  constructor(private config: ExtractorConfig) {}
  
  validate(source: any): boolean {
    switch (source.type) {
      case 'file': return source.file?.type === 'text/csv' || source.fileName?.toLowerCase().endsWith('.csv');
      case 'url': return source.url.toLowerCase().endsWith('.csv');
      case 'base64': return source.mimeType === 'text/csv';
      default: return false;
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    return { success: false, error: 'CSV parsing not yet implemented.', processingTime: 0 };
  }
}

export function createCsvExtractor(config: ExtractorConfig): CsvExtractor {
  return new CsvExtractor(config);
} 