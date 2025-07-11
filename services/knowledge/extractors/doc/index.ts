import type { DocumentExtractor, ExtractorConfig, ExtractionRequest, ExtractionResult, DocumentType } from '../../types.ts';

export class DocExtractor implements DocumentExtractor {
  name = 'doc' as const;
  supportedTypes: DocumentType[] = ['doc', 'docx'];
  constructor(private config: ExtractorConfig) {}
  
  validate(source: any): boolean {
    const docExtensions = ['.doc', '.docx'];
    const docMimeTypes = ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    
    switch (source.type) {
      case 'file': return docMimeTypes.includes(source.file?.type) || docExtensions.some(ext => source.fileName?.toLowerCase().endsWith(ext));
      case 'url': return docExtensions.some(ext => source.url.toLowerCase().includes(ext));
      case 'base64': return docMimeTypes.includes(source.mimeType);
      default: return false;
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    return { success: false, error: 'Word document extraction not yet implemented.', processingTime: 0 };
  }
}

export function createDocExtractor(config: ExtractorConfig): DocExtractor {
  return new DocExtractor(config);
} 