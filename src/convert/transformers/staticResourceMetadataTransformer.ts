/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { Readable } from 'stream';
import * as JSZip from 'jszip';
import { getExtension } from 'mime';
import { CentralDirectory, Open } from 'unzipper';
import { JsonMap } from '@salesforce/ts-types';
import { createWriteStream } from 'graceful-fs';
import { Logger, Messages, SfError } from '@salesforce/core';
import { isEmpty } from '@salesforce/kit';
import { baseName } from '../../utils';
import { WriteInfo } from '..';
import { SourceComponent } from '../../resolve';
import { SourcePath } from '../../common';
import { ensureFileExists } from '../../utils/fileSystemHandler';
import { pipeline } from '../streams';
import { getReplacementStreamForReadable } from '../replacements';
import { BaseMetadataTransformer } from './baseMetadataTransformer';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/source-deploy-retrieve', 'sdr');

let logger: Logger;
const getLogger = (): Logger => {
  if (!logger) {
    logger = Logger.childFromRoot('StaticResourceMetadataTransformer');
  }
  return logger;
};

export class StaticResourceMetadataTransformer extends BaseMetadataTransformer {
  public static readonly ARCHIVE_MIME_TYPES = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/jar',
  ]);

  // allowed to preserve API
  // eslint-disable-next-line class-methods-use-this
  public async toMetadataFormat(component: SourceComponent): Promise<WriteInfo[]> {
    const { content, type, xml } = component;
    if (!content) {
      throw messages.createError('noContentFound', [component.fullName, component.type.name]);
    }
    if (!xml) {
      throw messages.createError('error_parsing_xml', [component.fullName, component.type.name]);
    }

    // Zip the static resource from disk to a stream, compressing at level 9.
    const zipIt = (): Readable => {
      getLogger().debug(`zipping static resource: ${component.content}`);
      const zip = JSZip();

      // JSZip does not have an API for adding a directory of files recursively so we always
      // have to walk the component content. Replacements only happen if set on the component.
      for (const path of component.walkContent()) {
        const replacementStream = getReplacementStreamForReadable(component, path);
        const relPath = relative(content, path);
        const relPosixPath = relPath.replace(/\\/g, '/');
        zip.file(relPosixPath, replacementStream);
      }

      // If the generated zip is empty it means either no content files exist or they are
      // all force-ignored.  Throw an error in this case.
      if (isEmpty(zip.files)) {
        throw messages.createError('noContentFound', [component.fullName, component.type.name]);
      }

      return new Readable().wrap(
        zip
          .generateNodeStream({
            compression: 'DEFLATE',
            compressionOptions: { level: 9 },
            streamFiles: true,
          })
          .on('end', () => {
            getLogger().debug(`zip complete for: ${component.content}`);
          })
      );
    };

    return [
      {
        source: (await componentIsExpandedArchive(component))
          ? zipIt()
          : getReplacementStreamForReadable(component, content),
        output: join(type.directoryName, `${baseName(content)}.${type.suffix}`),
      },
      {
        source: getReplacementStreamForReadable(component, xml),
        output: join(type.directoryName, basename(xml)),
      },
    ];
  }

  public async toSourceFormat(component: SourceComponent, mergeWith?: SourceComponent): Promise<WriteInfo[]> {
    const { xml, content } = component;

    if (!content) {
      return [];
    }
    const componentContentType = await getContentType(component);
    const mergeContentPath = mergeWith?.content;
    const baseContentPath = getBaseContentPath(component, mergeWith);

    // only unzip an archive component if there isn't a merge component, or the merge component is itself expanded
    const shouldUnzipArchive =
      StaticResourceMetadataTransformer.ARCHIVE_MIME_TYPES.has(componentContentType) &&
      (!mergeWith || (mergeContentPath && mergeWith.tree.isDirectory(mergeContentPath)));

    if (shouldUnzipArchive) {
      // for the bulk of static resource writing we'll start writing ASAP
      // we'll still defer writing the resource-meta.xml file by pushing it onto the writeInfos
      await Promise.all(
        (
          await openZipFile(component, content)
        ).files
          .filter((f) => f.type === 'File')
          .map(async (f) => {
            const path = join(baseContentPath, f.path);
            const fullDest = isAbsolute(path)
              ? path
              : join(this.defaultDirectory ?? component.getPackageRelativePath('', 'source'), path);
            // push onto the pipeline and start writing now
            return this.pipeline(f.stream(), fullDest);
          })
      );
    }
    if (!xml) {
      throw messages.createError('error_parsing_xml', [component.fullName, component.type.name]);
    }
    return [
      {
        source: component.tree.stream(xml),
        output: mergeWith?.xml ?? component.getPackageRelativePath(basename(xml), 'source'),
      },
    ].concat(
      shouldUnzipArchive
        ? []
        : [
            {
              source: component.tree.stream(content),
              output: `${baseContentPath}.${getExtensionFromType(componentContentType)}`,
            },
          ]
    );
  }

  /**
   * Only separated into its own method for unit testing purposes
   * I was unable to find a way to stub/spy a pipline() call
   *
   * @param stream the data to be written
   * @param destination the destination path to be written
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  private async pipeline(stream: Readable, destination: string): Promise<void> {
    ensureFileExists(destination);
    await pipeline(stream, createWriteStream(destination));
  }

  /**
   * "Expanded" refers to a component whose content file is a zip file, and its current
   * state is unzipped.
   */
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const FALLBACK_TYPE_MAP = new Map<string, string>([
  ['text/javascript', 'js'],
  ['application/x-javascript', 'js'],
  ['application/x-zip-compressed', 'zip'],
  ['text/x-haml', 'haml'],
  ['image/x-png', 'png'],
  ['text/xml', 'xml'],
]);

const getContentType = async (component: SourceComponent): Promise<string> => {
  const resource = (await component.parseXml()).StaticResource as JsonMap;

  if (!resource || !Object.keys(resource).includes('contentType')) {
    throw new SfError(
      messages.getMessage('error_static_resource_missing_resource_file', [
        join('staticresources', component.name ?? component.xml ?? component.type.name),
      ]),
      'LibraryError'
    );
  }

  const output = resource.contentType ?? DEFAULT_CONTENT_TYPE;

  if (typeof output !== 'string') {
    throw new SfError(
      `Expected a string for contentType in ${component.name} (${component.xml}) but got ${output?.toString()}`
    );
  }
  return output;
};

const getBaseContentPath = (component: SourceComponent, mergeWith?: SourceComponent): SourcePath => {
  if (mergeWith?.content) {
    return join(dirname(mergeWith.content), baseName(mergeWith?.content));
  }
  if (typeof component.content === 'string') {
    const baseContentPath = component.getPackageRelativePath(component.content, 'source');
    return join(dirname(baseContentPath), baseName(baseContentPath));
  }
  throw new SfError(`Expected a content path for ${component.name} (${component.xml})`);
};

const getExtensionFromType = (contentType: string): string =>
  // return registered ext, fallback, or the default (application/octet-stream -> bin)
  getExtension(contentType) ?? FALLBACK_TYPE_MAP.get(contentType) ?? getExtension(DEFAULT_CONTENT_TYPE) ?? 'bin';

const componentIsExpandedArchive = async (component: SourceComponent): Promise<boolean> => {
  const { content, tree } = component;
  if (content && tree.isDirectory(content)) {
    const contentType = await getContentType(component);
    if (StaticResourceMetadataTransformer.ARCHIVE_MIME_TYPES.has(contentType)) {
      return true;
    }
    throw new SfError(
      messages.getMessage('error_static_resource_expected_archive_type', [contentType, component.name]),
      'LibraryError'
    );
  }
  return false;
};

/** wrapper around the Open command so we can emit a nicer error for bad zip files  */
async function openZipFile(component: SourceComponent, content: string): Promise<CentralDirectory> {
  try {
    return await Open.buffer(await component.tree.readFile(content));
  } catch (e) {
    throw new SfError(`Unable to open zip file ${content} for ${component.name} (${component.xml})`, 'BadZipFile', [
      'Check that your file really is a valid zip archive',
    ]);
  }
}
