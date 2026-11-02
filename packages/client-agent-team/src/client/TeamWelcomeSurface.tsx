import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamPagePayload } from './slots.ts'
import css from './conversation.module.css'

/**
 * The Team page's empty half: no page resolved (no Workspace browsed, or a tab
 * whose address carries no target), or a Workspace with no Channel selected
 * yet. Shared by the dock's panes and the sidebar tab bodies so the empty
 * line reads the same in every host, and only one component owns it.
 */
export function WelcomeSurface({ workspaceId, workspaceTitle, t }: { workspaceId?: WorkspaceId; workspaceTitle?: string; t: TeamPagePayload['t'] }) {
  const welcome = workspaceId === undefined
    ? { eyebrow: t('teamMode'), title: t('team'), body: t('empty') }
    : { eyebrow: workspaceTitle ?? workspaceId, title: t('channels'), body: t('selectChannelHint') }
  return <main className={css.welcomeSurface} data-team-dock-welcome>
    <div className={css.welcome}>
      <span className={css.welcomeEyebrow}>{welcome.eyebrow}</span>
      <h1>{welcome.title}</h1>
      <p>{welcome.body}</p>
    </div>
  </main>
}
