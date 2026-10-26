import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { DocumentEnginePort } from './document-engine.port';
import { HttpDocumentEngine } from './http-document-engine';

@Module({
  imports: [ConfigModule],
  providers: [{ provide: DocumentEnginePort, useClass: HttpDocumentEngine }],
  exports: [DocumentEnginePort],
})
export class DocumentEngineModule {}
