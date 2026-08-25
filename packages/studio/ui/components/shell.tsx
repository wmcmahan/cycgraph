'use client';

/**
 * The studio frame: a shadcn sidebar carrying the three lenses and the
 * stack banner, with a fixed shell — only the page content scrolls.
 */

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Layers, ScrollText, Wrench, Play, Workflow } from 'lucide-react';
import { api, type StackInfo } from '../lib/api';
import { Badge } from './primitives';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from './ui/sidebar';
import { Separator } from './ui/separator';
import { TooltipProvider } from './ui/tooltip';

const PAGES = [
  { href: '/runs/', label: 'Runs', icon: Layers },
  { href: '/logs/', label: 'Logs', icon: ScrollText },
  { href: '/improve/', label: 'Improve', icon: Wrench },
  { href: '/scenarios/', label: 'Scenarios', icon: Play },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [stack, setStack] = useState<StackInfo | undefined>();

  useEffect(() => {
    api<{ stack: StackInfo }>('/api/scenarios')
      .then((body) => setStack(body.stack))
      .catch(() => setStack(undefined));
  }, []);

  const current = PAGES.find((page) => pathname.startsWith(page.href.slice(0, -1)));

  return (
    <TooltipProvider>
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link href="/logs/">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Workflow className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">cycgraph</span>
                    <span className="truncate text-xs text-muted-foreground">studio</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {PAGES.map(({ href, label, icon: Icon }) => (
                  <SidebarMenuItem key={href}>
                    <SidebarMenuButton asChild isActive={pathname.startsWith(href.slice(0, -1))} tooltip={label}>
                      <Link href={href}>
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="space-y-1.5 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            {stack ? (
              <>
                <div>model <span className="text-foreground">{stack.model}</span></div>
                <div className="flex flex-wrap gap-1">
                  {stack.available.map((feature) => <Badge key={feature} tone="ok">{feature}</Badge>)}
                  {stack.gaps.map((gap) => <Badge key={gap.feature} tone="dim" className="line-through">{gap.feature}</Badge>)}
                </div>
              </>
            ) : (
              <div>connecting…</div>
            )}
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="text-sm font-medium">{current?.label ?? 'Studio'}</span>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </SidebarInset>
    </SidebarProvider>
    </TooltipProvider>
  );
}
