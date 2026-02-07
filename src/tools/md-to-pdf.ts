import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from './interface.js';

export class MdToPdfTool implements Tool {
  name = 'md_to_pdf';
  description = 'Convert a markdown file to PDF.';
  parameters = {
    type: 'object',
    properties: {
      input_path: {
        type: 'string',
        description: 'Path to the .md file to convert.',
      },
      output_path: {
        type: 'string',
        description: 'Where to write the PDF. Defaults to same path with .pdf extension.',
      },
    },
    required: ['input_path'],
  };

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const inputPath = args.input_path as string;
    if (!inputPath) {
      return { success: false, output: '', error: 'input_path is required.' };
    }

    const resolvedInput = resolve(context.workingDirectory, inputPath);
    if (!existsSync(resolvedInput)) {
      return { success: false, output: '', error: `File not found: ${resolvedInput}` };
    }

    const outputPath = args.output_path
      ? resolve(context.workingDirectory, args.output_path as string)
      : resolvedInput.replace(/\.md$/i, '.pdf');

    try {
      const { mdToPdf } = await import('md-to-pdf');
      const result = await mdToPdf({ path: resolvedInput });

      if (!result?.content) {
        return { success: false, output: '', error: 'Conversion produced no output.' };
      }

      await writeFile(outputPath, result.content);
      const size = result.content.length;
      return { success: true, output: `PDF written to ${outputPath} (${size} bytes)` };
    } catch (err) {
      return { success: false, output: '', error: `Conversion failed: ${(err as Error).message}` };
    }
  }
}
