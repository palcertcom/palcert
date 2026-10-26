import { Module } from '@nestjs/common';
import { ApiConfigService } from '../../config/api-config.service';
import { ConfigModule } from '../../config/config.module';
import { ClamAvScanner } from './clamav-scanner';
import { FakeMalwareScanner } from './fake-scanner';
import { MalwareScannerPort } from './malware-scanner.port';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MalwareScannerPort,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService): MalwareScannerPort => {
        const scanner = config.scanner;
        // Configuration validation already refuses `fake` in production.
        if (scanner.kind === 'fake') return new FakeMalwareScanner();
        return new ClamAvScanner({
          host: scanner.clamavHost,
          port: scanner.clamavPort,
          chunkBytes: scanner.chunkBytes,
          connectTimeoutMs: 5_000,
        });
      },
    },
  ],
  exports: [MalwareScannerPort],
})
export class ScannerModule {}
