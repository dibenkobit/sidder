import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2.5 font-semibold tracking-[-0.04em]">
          <span
            aria-hidden="true"
            className="grid size-6 grid-cols-2 grid-rows-2 gap-[2px] border border-fd-foreground/30 p-1"
          >
            <span className="bg-fd-foreground" />
            <span className="bg-fd-foreground/30" />
            <span className="col-span-2 bg-fd-foreground" />
          </span>
          {appName}
        </span>
      ),
    },
    links: [
      {
        text: 'Documentation',
        url: '/docs',
        active: 'nested-url',
      },
      {
        text: 'Quick start',
        url: '/docs/getting-started',
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
