import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { useCallback, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { useNavigationState } from "@/hooks/use-navigation-state";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useDbSync } from "@agent-native/core/client";
import {
  AppProviders,
  CommandMenu,
  appPath,
  configureTracking,
  createAgentNativeQueryClient,
  getThemeInitScript,
  useCommandMenuShortcut,
} from "@agent-native/core/client";
import { IconSun, IconMoon, IconLanguage } from "@tabler/icons-react";
import { Layout as AppLayout } from "@/components/layout/Layout";
import { TAB_ID } from "@/lib/tab-id";
import { APP_TITLE } from "@/lib/app-config";
import i18n, { persistLang, type Lang } from "@/lib/i18n";
import type { LinksFunction } from "react-router";
import stylesheet from "./global.css?url";

configureTracking({
  getDefaultProps: (_name, properties) => ({
    ...properties,
    app: "orchestrator",
  }),
});

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
];

const THEME_INIT_SCRIPT = getThemeInitScript();

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
        />
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
        <link rel="manifest" href={appPath("/manifest.json")} />
        <meta name="theme-color" content="#18181B" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content={APP_TITLE} />
        <link rel="icon" type="image/svg+xml" href={appPath("/favicon.svg")} />
        <link rel="apple-touch-icon" href={appPath("/icon-180.svg")} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function DbSyncSetup() {
  const qc = useQueryClient();
  useNavigationState();
  useDbSync({
    queryClient: qc,
    ignoreSource: TAB_ID,
  });
  return null;
}

function ThemeToggleItem() {
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useTranslation();
  const isDark = resolvedTheme === "dark";
  return (
    <CommandMenu.Item
      onSelect={() => setTheme(isDark ? "light" : "dark")}
      keywords={["theme", "dark", "light", "mode", "主题"]}
    >
      {isDark ? <IconSun size={16} /> : <IconMoon size={16} />}
      {t("common.theme")}: {isDark ? "☀︎" : "☾"}
    </CommandMenu.Item>
  );
}

function LanguageToggleItem() {
  const { i18n: inst, t } = useTranslation();
  const next: Lang = inst.language === "zh" ? "en" : "zh";
  return (
    <CommandMenu.Item
      onSelect={() => {
        void inst.changeLanguage(next);
        persistLang(next);
      }}
      keywords={["language", "lang", "语言", "中文", "english"]}
    >
      <IconLanguage size={16} />
      {t("common.language")}: {next === "zh" ? "中文" : "English"}
    </CommandMenu.Item>
  );
}

function AppContent() {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const { t } = useTranslation();
  useCommandMenuShortcut(useCallback(() => setCmdkOpen(true), []));
  return (
    <>
      <CommandMenu open={cmdkOpen} onOpenChange={setCmdkOpen}>
        <CommandMenu.Group heading={t("common.theme")}>
          <ThemeToggleItem />
          <LanguageToggleItem />
        </CommandMenu.Group>
      </CommandMenu>
      <AppLayout>
        <Outlet />
      </AppLayout>
    </>
  );
}

export default function Root() {
  const [queryClient] = useState(() => createAgentNativeQueryClient());
  return (
    <I18nextProvider i18n={i18n}>
      <AppProviders queryClient={queryClient}>
        <DbSyncSetup />
        <AppContent />
      </AppProviders>
    </I18nextProvider>
  );
}

export { ErrorBoundary } from "@agent-native/core/client";
