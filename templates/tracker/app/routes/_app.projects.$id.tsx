import { useState, useEffect } from "react";
import { useParams, Link } from "react-router";
import { useProjects } from "@/hooks/use-tracker";
import { useActionMutation } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconLoader2,
} from "@tabler/icons-react";

export function meta() {
  return [{ title: "项目设置 · Tracker" }];
}

export default function ProjectSettingsRoute() {
  const { id = "" } = useParams();
  const { data, isLoading } = useProjects();
  const projects = Array.isArray(data) ? data : [];
  const project = projects.find((p) => p.id === id);

  const qc = useQueryClient();
  const update = useActionMutation("update-project", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-projects"] });
      toast.success("项目已保存");
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "保存失败";
      toast.error(msg);
    },
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gitRemote, setGitRemote] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  useEffect(() => {
    if (project) {
      setName(project.name ?? "");
      setDescription(project.description ?? "");
      setGitRemote((project as any).gitRemote ?? "");
      setDefaultBranch((project as any).defaultBranch ?? "main");
    }
  }, [project?.id]);

  function handleSave() {
    if (!project) return;
    update.mutate({
      id,
      name: name.trim() || undefined,
      description,
      gitRemote,
      defaultBranch: defaultBranch || "main",
    });
  }

  return (
    <div className="mx-auto max-w-2xl p-5 sm:p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4 gap-1.5">
        <Link to="/projects">
          <IconArrowLeft className="size-4" /> 项目列表
        </Link>
      </Button>

      {isLoading && !project ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : !project ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          项目不存在或无权访问
        </div>
      ) : (
        <>
          <div className="mb-6 flex items-center gap-3">
            <span className="inline-flex h-6 items-center rounded bg-muted px-2 font-mono text-xs font-semibold text-muted-foreground">
              {(project as any).key}
            </span>
            <h1 className="text-xl font-semibold">{project.name}</h1>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">项目设置</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="proj-name">项目名称</Label>
                <Input
                  id="proj-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="项目名称"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="proj-desc">项目描述</Label>
                <Textarea
                  id="proj-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="简述项目目标和范围…"
                  rows={3}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="proj-remote">Git 远程仓库</Label>
                <Input
                  id="proj-remote"
                  value={gitRemote}
                  onChange={(e) => setGitRemote(e.target.value)}
                  placeholder="https://github.com/org/repo"
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="proj-branch">默认分支</Label>
                <Input
                  id="proj-branch"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  placeholder="main"
                  className="font-mono text-sm"
                />
              </div>

              <Button
                className="gap-1.5"
                onClick={handleSave}
                disabled={update.isPending || !name.trim()}
              >
                {update.isPending ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : (
                  <IconDeviceFloppy className="size-4" />
                )}
                保存更改
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
