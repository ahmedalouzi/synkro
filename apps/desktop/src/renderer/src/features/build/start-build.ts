import { useWorkspaceStore } from '../../stores/workspace-store';
import { useBuildStore } from '../../stores/build-store';
import { buildApi } from '../../services/build-api';

/**
 * Starts a Cloud Build of the open project. React Native projects get a dependency check first: the server's
 * `npm ci` rejects peer conflicts (ERESOLVE) that the local preview never hits, so they show in the Build panel
 * with "Fix dependencies" instead of as a failed build minutes later. `skipDepsCheck`: "Build anyway", or right
 * after a fix that passed.
 */
export async function startCloudBuild(opts: { skipDepsCheck?: boolean } = {}): Promise<void> {
  const project = useWorkspaceStore.getState().project;
  if (!project) return;
  const store = useBuildStore.getState();
  const platform = project.platform === 'expo' || project.platform.startsWith('react-native') ? 'react-native' : 'flutter';
  if (platform === 'react-native' && !opts.skipDepsCheck && window.peep.checkBuildDependencies) {
    store.setDepsCheck({ state: 'checking', problems: [] });
    // A check that fails to run does not block the build.
    const result = await window.peep.checkBuildDependencies(project.path).catch(() => ({ ok: true, problems: [] }));
    if (!result.ok) {
      store.setDepsCheck({ state: 'problems', problems: result.problems });
      return;
    }
  }
  store.setDepsCheck(null);
  try {
    const build = await buildApi.startBuild(project.path, platform, 'apk');
    useBuildStore.getState().setCurrentBuild(build);
  } catch (err) {
    console.error('BUILD START FAILED:', err);
  }
}

/** "Fix dependencies": `npx expo install --fix`, then the build starts if nothing is left. */
export async function fixBuildDependencies(): Promise<void> {
  const project = useWorkspaceStore.getState().project;
  const store = useBuildStore.getState();
  if (!project || !window.peep.fixBuildDependencies || store.depsCheck?.state !== 'problems') return;
  const before = store.depsCheck.problems;
  store.setDepsCheck({ state: 'fixing', problems: before });
  const result = await window.peep.fixBuildDependencies(project.path)
    .catch((err: unknown) => ({ ok: false, problems: before, fixError: String(err) }));
  if (result.ok) {
    await startCloudBuild({ skipDepsCheck: true });
  } else {
    store.setDepsCheck({ state: 'problems', problems: result.problems, afterFix: true, fixError: result.fixError });
  }
}
