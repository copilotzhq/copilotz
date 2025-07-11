import type { DocumentExtractor, ExtractorConfig, ExtractionRequest, ExtractionResult, DocumentType } from '../../types.ts';

export class AudioExtractor implements DocumentExtractor {
  name = 'audio' as const;
  supportedTypes: DocumentType[] = ['audio'];
  constructor(private config: ExtractorConfig) {}
  
  validate(source: any): boolean {
    const audioExtensions = ['.mp3', '.wav', '.aac', '.m4a'];
    const audioMimeTypes = ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/mp4'];
    
    switch (source.type) {
      case 'file': return audioMimeTypes.includes(source.file?.type) || audioExtensions.some(ext => source.fileName?.toLowerCase().endsWith(ext));
      case 'url': return audioExtensions.some(ext => source.url.toLowerCase().includes(ext));
      case 'base64': return audioMimeTypes.includes(source.mimeType);
      default: return false;
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    return { success: false, error: 'Audio transcription not yet implemented.', processingTime: 0 };
  }
}

export function createAudioExtractor(config: ExtractorConfig): AudioExtractor {
  return new AudioExtractor(config);
} 