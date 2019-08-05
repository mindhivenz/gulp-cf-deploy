import ensureGitUpToDate from '@mindhive/deploy/ensureGitUpToDate'
import execFile from '@mindhive/deploy/execFile'
import yarnPublish from '@mindhive/deploy/yarnPublish'
import del from 'del'
import gulp from 'gulp'
import path from 'path'

const projectDir = path.dirname(__dirname)
process.chdir(projectDir)
const srcDir = `src`
const distDir = `dist`

const clean = () => del(distDir)

const build = () =>
  execFile('tsc', ['--outDir', distDir, '--project', srcDir], {
    pipeOutput: true,
  })

export const dist = gulp.series(clean, build)

const gitUpToDate = () => ensureGitUpToDate(projectDir)

const publish = () => yarnPublish({ packageDir: projectDir })

export const release = gulp.series(gitUpToDate, dist, publish)
