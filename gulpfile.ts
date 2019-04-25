import ensureGitUpToDate from '@mindhive/deploy/ensureGitUpToDate'
import execFile from '@mindhive/deploy/execFile'
import yarnPublish from '@mindhive/deploy/yarnPublish'
import del from 'del'
import gulp from 'gulp'

const distDir = 'dist'

const clean = () => del(distDir)

const build = () =>
  execFile('tsc', ['--outDir', distDir, '--project', 'src'], {
    pipeOutput: true,
  })

export const dist = gulp.series(clean, build)

const gitUpToDate = () => ensureGitUpToDate('.')

const publish = () => yarnPublish({ packageDir: '.' })

export const release = gulp.series(gitUpToDate, dist, publish)
