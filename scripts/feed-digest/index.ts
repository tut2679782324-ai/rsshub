/**
 * Read one or more RSS/Atom feeds and print the entries published within a
 * recent time window as plain text, ready to be summarised.
 *
 * Usage:
 *   pnpm feed:digest [--hours=24] [--format=markdown|json] [--max-chars=0] <url-or-file>...
 *
 * Sources are only ever taken from the command line, so no feed address has
 * to be stored in the repository. Set NODE_USE_ENV_PROXY=1 to make the
 * requests honour HTTPS_PROXY.
 */
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { load } from 'cheerio';

import { config } from '../../lib/config';
import parser from '../../lib/utils/rss-parser';

interface DigestItem {
    title: string;
    link?: string;
    author?: string;
    category?: string[];
    pubDate?: string;
    content: string;
    source: string;
}

interface FeedResult {
    source: string;
    title?: string;
    total: number;
    undated: number;
    newest?: string;
    oldest?: string;
    items: DigestItem[];
    error?: string;
}

type FeedItem = Awaited<ReturnType<typeof parser.parseString>>['items'][number];

const blockTags = 'p, div, br, li, tr, h1, h2, h3, h4, h5, h6, blockquote';
const noiseTags = 'script, style, iframe, figure, img, video, audio, svg, noscript';

const htmlToText = (html: string): string => {
    const $ = load(html, null, false);
    $(noiseTags).remove();
    $(blockTags).each((_, element) => {
        $(element).append('\n');
    });
    return $.text()
        .replaceAll(' ', ' ')
        .split('\n')
        .map((line) => line.replaceAll(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
};

const truncate = (text: string, maxChars: number): string => (maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);

const toCategories = (value: unknown): string[] | undefined => {
    const list = (Array.isArray(value) ? value : [value]).map((entry) => (typeof entry === 'string' ? entry : (entry as { _?: string })?._)).filter((entry): entry is string => Boolean(entry?.trim()));
    return list.length ? list : undefined;
};

const toDate = (item: FeedItem): Date | undefined => {
    const raw = item.isoDate ?? item.pubDate;
    const date = raw ? new Date(raw) : undefined;
    return date && !Number.isNaN(date.getTime()) ? date : undefined;
};

const readSource = async (source: string): Promise<string> => {
    if (!/^https?:\/\//i.test(source)) {
        return fs.readFile(source, 'utf8');
    }
    const response = await fetch(source, {
        headers: {
            'User-Agent': config.ua,
            Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
        },
        signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
};

const readFeed = async (source: string, since: number, maxChars: number): Promise<FeedResult> => {
    try {
        const feed = await parser.parseString(await readSource(source));
        const feedTitle = feed.title?.trim() || source;
        const dated = feed.items.map((item) => ({ item, date: toDate(item) }));
        const times = dated.flatMap(({ date }) => (date ? [date.getTime()] : []));

        return {
            source,
            title: feedTitle,
            total: feed.items.length,
            undated: dated.length - times.length,
            newest: times.length ? new Date(Math.max(...times)).toISOString() : undefined,
            oldest: times.length ? new Date(Math.min(...times)).toISOString() : undefined,
            // Entries without a usable date are kept: dropping them silently could hide news.
            items: dated
                .filter(({ date }) => !date || date.getTime() >= since)
                .map(({ item, date }) => ({
                    title: (item.title ?? '').trim(),
                    link: item.link?.trim(),
                    author: (item.creator ?? item.author)?.trim() || undefined,
                    category: toCategories(item.categories ?? item.category),
                    pubDate: date?.toISOString(),
                    content: truncate(htmlToText(item['content:encoded'] ?? item.content ?? item.summary ?? item.description ?? ''), maxChars),
                    source: feedTitle,
                })),
        };
    } catch (error) {
        return { source, total: 0, undated: 0, items: [], error: error instanceof Error ? error.message : String(error) };
    }
};

const dedupe = (items: DigestItem[]): DigestItem[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = item.link?.split(/[?#]/)[0] || item.title.toLowerCase();
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};

const toMarkdown = (feeds: FeedResult[], items: DigestItem[], hours: number, now: Date): string => {
    const lines = [`# Feed digest: last ${hours}h (generated ${now.toISOString()})`, ''];
    for (const feed of feeds) {
        lines.push(
            feed.error
                ? `- FAILED ${feed.source}: ${feed.error}`
                : `- ${feed.title}: ${feed.items.length} of ${feed.total} entries in window (feed spans ${feed.oldest ?? 'unknown'} to ${feed.newest ?? 'unknown'}${feed.undated ? `, ${feed.undated} undated` : ''})`
        );
    }
    for (const [index, item] of items.entries()) {
        const meta = [item.source, item.pubDate ?? 'no date', item.author, item.category?.join(', ')].filter(Boolean).join(' | ');
        lines.push('', `## ${index + 1}. ${item.title}`, meta, item.link ?? '', '', item.content);
    }
    return lines.join('\n');
};

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        hours: { type: 'string', default: '24' },
        format: { type: 'string', default: 'markdown' },
        'max-chars': { type: 'string', default: '0' },
    },
});

const hours = Number(values.hours);
const maxChars = Number(values['max-chars']);

if (!positionals.length || !Number.isFinite(hours) || hours <= 0 || !Number.isFinite(maxChars) || !['markdown', 'json'].includes(values.format)) {
    process.stderr.write('Usage: pnpm feed:digest [--hours=24] [--format=markdown|json] [--max-chars=0] <url-or-file>...\n');
    process.exit(2);
}

const now = new Date();
const feeds = await Promise.all(positionals.map((source) => readFeed(source, now.getTime() - hours * 3_600_000, maxChars)));
const items = dedupe(feeds.flatMap((feed) => feed.items)).toSorted((a, b) => (b.pubDate ?? '').localeCompare(a.pubDate ?? ''));

process.stdout.write(
    (values.format === 'json'
        ? JSON.stringify({ generatedAt: now.toISOString(), hours, feeds: feeds.map(({ items: feedItems, ...rest }) => ({ ...rest, inWindow: feedItems.length })), items }, null, 2)
        : toMarkdown(feeds, items, hours, now)) + '\n'
);

// A feed that cannot be read, or that has nothing at all, must not look like a quiet news day.
const broken = feeds.filter((feed) => feed.error || feed.total === 0);
if (broken.length) {
    for (const feed of broken) {
        process.stderr.write(`Could not read any entry from ${feed.source}: ${feed.error ?? 'the feed is empty'}\n`);
    }
    process.exitCode = 1;
}
