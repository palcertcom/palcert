import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const Trimmed = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export const DOCUMENT_NAME_MAX_LENGTH = 200;
/** Long enough for any real filename; bounded so it cannot be a payload. */
export const ORIGINAL_FILENAME_MAX_LENGTH = 1024;
/** PostgreSQL integer; the per-format limits are far below this. */
const MAX_DECLARED_SIZE = 2_147_483_647;

export class DocumentParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  documentId!: string;
}

export class DocumentVersionParamDto extends DocumentParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  versionId!: string;
}

export class DocumentCollectionQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateDocumentDto {
  @ApiProperty({ example: 'My PhD thesis', maxLength: DOCUMENT_NAME_MAX_LENGTH })
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(DOCUMENT_NAME_MAX_LENGTH)
  displayName!: string;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ maxLength: DOCUMENT_NAME_MAX_LENGTH })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(DOCUMENT_NAME_MAX_LENGTH)
  displayName?: string;
}

export class CreateDocumentVersionDto {
  @ApiProperty({
    example: 'thesis-final.docx',
    description: 'The file name as the user sees it. Metadata only; it never names storage.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(ORIGINAL_FILENAME_MAX_LENGTH)
  originalFilename!: string;

  @ApiPropertyOptional({
    example: 'application/pdf',
    description: 'The content type the browser reports. Advisory; the content decides.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  declaredMimeType?: string;

  @ApiProperty({ description: 'Exact size in bytes of the file about to be uploaded.', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_DECLARED_SIZE)
  sizeBytes!: number;

  @ApiPropertyOptional({
    description:
      'Optional lower-case hex SHA-256 the browser computed. Used for early mismatch detection ' +
      'only; PalCert computes the authoritative digest itself.',
    pattern: '^[0-9a-f]{64}$',
  })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  sha256?: string;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class DocumentVersionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty() status!: string;
  @ApiProperty() originalFilename!: string;
  @ApiProperty({ nullable: true, type: String }) declaredMimeType!: string | null;
  @ApiProperty({ nullable: true, type: String }) detectedMimeType!: string | null;
  @ApiProperty({ nullable: true, type: String }) detectedFormat!: string | null;
  @ApiProperty({ nullable: true, type: Number }) sizeBytes!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Authoritative SHA-256, once READY.' })
  sha256!: string | null;
  @ApiProperty({ nullable: true, type: String }) rejectionCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) failureCode!: string | null;
  @ApiProperty() retryable!: boolean;
  @ApiProperty({ nullable: true, type: String }) uploadExpiresAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) uploadedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) validatedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) scannedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) readyAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) rejectedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) failedAt!: string | null;
}

export class DocumentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true, type: DocumentVersionDto })
  latestVersion!: DocumentVersionDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class UploadAuthorizationDto {
  @ApiProperty({ enum: ['PUT'] }) method!: 'PUT';
  @ApiProperty({
    description:
      'SENSITIVE, SHORT-LIVED BEARER MATERIAL. Anyone holding this URL can write the staged ' +
      'object until it expires. Never log it, never store it, never share it. This example is ' +
      'not a real signed URL.',
    example: 'https://storage.example/quarantine/staging/...?X-Amz-Signature=example',
  })
  url!: string;
  @ApiProperty({ description: 'Headers the browser must send exactly as given.' })
  headers!: Record<string, string>;
  @ApiProperty() expiresAt!: string;
}

export class CreateDocumentVersionResponseDto {
  @ApiProperty({ type: DocumentVersionDto }) version!: DocumentVersionDto;
  @ApiProperty({ type: UploadAuthorizationDto }) upload!: UploadAuthorizationDto;
}

export class DownloadAuthorizationDto {
  @ApiProperty({ enum: ['GET'] }) method!: 'GET';
  @ApiProperty({
    description:
      'SENSITIVE, SHORT-LIVED BEARER MATERIAL for one GET of the exact clean object. This ' +
      'example is not a real signed URL.',
    example: 'https://storage.example/documents/users/...?X-Amz-Signature=example',
  })
  url!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ description: 'The sanitized filename the download will carry.' })
  filename!: string;
}

export class DocumentPageDto {
  @ApiProperty({ type: [DocumentDto] }) items!: DocumentDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class DocumentVersionPageDto {
  @ApiProperty({ type: [DocumentVersionDto] }) items!: DocumentVersionDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
