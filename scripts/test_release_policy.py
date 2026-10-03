import os
from pathlib import Path
import subprocess
import tempfile
import unittest


POLICY = Path(__file__).resolve().with_name('release-policy.sh')


class ReleasePolicyTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='stakl-release-policy-')
        self.addCleanup(directory.cleanup)
        self.directory = directory.name
        self.environment = {
            **os.environ,
            'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_AUTHOR_NAME': 'Release fixture',
            'GIT_AUTHOR_EMAIL': 'release@example.invalid',
            'GIT_COMMITTER_NAME': 'Release fixture',
            'GIT_COMMITTER_EMAIL': 'release@example.invalid',
        }
        self.git('init', '-q', '--initial-branch=main')
        self.git('commit', '-q', '--allow-empty', '-m', 'stable')
        self.stable = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', self.stable)
        self.git('switch', '-q', '-c', 'dev')
        self.git('commit', '-q', '--allow-empty', '-m', 'development')
        self.dev = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/dev', self.dev)
        self.git('switch', '-q', '-c', 'feature')
        self.git('commit', '-q', '--allow-empty', '-m', 'unmerged feature')
        self.feature = self.git('rev-parse', 'HEAD')

    def git(self, *arguments):
        return subprocess.run(
            ['git', *arguments], cwd=self.directory, env=self.environment,
            check=True, text=True, capture_output=True,
        ).stdout.strip()

    def policy(self, tag, commit):
        return subprocess.run(
            ['bash', str(POLICY), tag, commit], cwd=self.directory,
            env=self.environment, text=True, capture_output=True,
        )

    def test_stable_commit_selects_stable_release(self):
        result = self.policy('v0.2.0', self.stable)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('prerelease=false\n', result.stdout)
        self.assertIn('source_branch=main\n', result.stdout)

    def test_dev_commit_selects_beta_release(self):
        result = self.policy('v0.2.0-beta.1', self.dev)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('prerelease=true\n', result.stdout)
        self.assertIn('source_branch=dev\n', result.stdout)

    def test_stable_release_rejects_unmerged_development(self):
        result = self.policy('v0.2.0', self.dev)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('origin/main', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_beta_release_rejects_unmerged_feature(self):
        result = self.policy('v0.2.0-beta.1', self.feature)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('origin/dev', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_release_rejects_invalid_tag_formats(self):
        for tag in ['v0.2', 'v01.2.3', 'v0.2.0-beta.0', 'v0.2.0-beta.x',
                    'v0.2.0-alpha.1', 'v0.2.0+build.1']:
            with self.subTest(tag=tag):
                result = self.policy(tag, self.stable)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('release tag', result.stderr)
                self.assertEqual(result.stdout, '')

    def test_release_rejects_missing_source_branch(self):
        self.git('update-ref', '-d', 'refs/remotes/origin/dev')
        result = self.policy('v0.2.0-beta.1', self.dev)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('origin/dev', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_release_rejects_nonexistent_commit(self):
        result = self.policy('v0.2.0', '0000000000000000000000000000000000000000')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('commit', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_annotated_tag_resolves_to_its_commit(self):
        self.git('tag', '-a', 'v0.2.0-beta.1', self.dev, '-m', 'beta fixture')
        tag_object = self.git('rev-parse', 'v0.2.0-beta.1')
        result = self.policy('v0.2.0-beta.1', tag_object)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('prerelease=true\n', result.stdout)
