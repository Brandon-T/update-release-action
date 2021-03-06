import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'
import { GitHub } from '@actions/github'
import { context } from '@actions/github'

const glob = require("glob")

type ReleaseResult = {id: number, name: string, url: string, prerelease: boolean, draft: boolean}

declare global {
    interface PromiseConstructor {
        allSettled(promises: Array<Promise<any>>): Promise<Array<{ status: 'fulfilled' | 'rejected', value?: any, reason?: any }>>;
    }
}

/*async function check_tag_valid(tag: string): Promise<any> {
    //const { exec } = require('child_process');
    const command = 'git check- ref - format `${ tag }` && echo 1 || echo 0'
    
    return new Promise((resolve, reject) {
        exec(command, (err, stdout, stderr) => {
            if (err) {
                reject('Invalid Tag')
              return
            }
          
            if (stdout === '1') {
                resolve('true')
                return
            }

            if (stderr === '1') {
                resolve('true')
                return
            }
            
            reject('Invalid Tag')
        });
    })
}*/

async function wait_for(milliseconds: number): Promise<void> {
    return new Promise(function (resolve, reject) {
        if (isNaN(milliseconds) || milliseconds <= 0) {
            reject('Invalid time')
            return
        }
        
        setTimeout(() => { resolve() }, milliseconds)
    })
}

async function try_promise(operation: () => Promise<any>, delay: number, amount_of_retries: number): Promise<any> {
    return new Promise((resolve, reject) => {
        return operation()
            .then(resolve)
            .catch(reason => {
                if (amount_of_retries - 1 > 0) {
                    return wait_for(delay)
                        .then(try_promise.bind(null, operation, delay, amount_of_retries - 1))
                        .then(resolve)
                        .catch(reject);
                }
                return reject(reason)
            })
    })
}

async function get_or_create_release(token: string, owner: string, repo: string, release_name: string | undefined, tag: string, ref: string, delete_existing: boolean, draft_release: boolean, bump_tag: boolean): Promise<ReleaseResult> {
    const client = new GitHub(token)

    try {
        if (bump_tag) {
            //Is valid SHA1 or SHA256
            if (ref.match("^[a-fA-F0-9]{40,64}$") != null) {
                try {
                    await client.git.updateRef({
                        force: false,
                        owner: owner,
                        ref: `tags/${tag}`,
                        repo: repo,
                        sha: ref
                    })
                } catch (error) {
                    if (error.status !== 422) {
                        throw error
                    }
                }
            }
            else {
                await client.repos.getBranch({
                    branch: ref,
                    owner: owner,
                    repo: repo
                }).then((value) => {
                    return client.git.updateRef({
                        force: false,
                        owner: owner,
                        ref: `tags/${ tag }`,
                        repo: repo,
                        sha: value.data.commit.sha
                    })
                })
            }
        }

        const release = await client.repos.getReleaseByTag({
            owner: owner,
            repo: repo,
            tag: tag
        })

        if (delete_existing) {
            await client.repos.deleteRelease({
                owner: owner,
                release_id: release.data.id,
                repo: repo
            })

            const result = await client.repos.createRelease({
                draft: draft_release,
                name: release_name,
                owner: owner,
                repo: repo,
                tag_name: tag,
                target_commitish: ref
            })

            return {
                id: result.data.id,
                name: result.data.name,
                url: result.data.upload_url,
                prerelease: result.data.prerelease,
                draft: result.data.draft
            }
        }

        return {
            id: release.data.id,
            name: release.data.name,
            url: release.data.upload_url,
            prerelease: release.data.prerelease,
            draft: release.data.draft
        }
    } catch (error) {
        if (error.status === 404) {
            const result = await client.repos.createRelease({
                draft: draft_release,
                name: release_name,
                owner: owner,
                repo: repo,
                tag_name: tag,
                target_commitish: ref
            })
            
            return {
                id: result.data.id,
                name: result.data.name,
                url: result.data.upload_url,
                prerelease: result.data.prerelease,
                draft: result.data.draft
            }
        }
        
        throw error;
    }
}

async function update_release(token: string, release_id: number, owner: string, repo: string, name?: string, tag?: string, commit?: string, notes?: string, prerelease?: boolean, draft_release?: boolean): Promise<any> {
    const client = new GitHub(token)

    return await client.repos.updateRelease({
        body: notes,
        draft: draft_release,
        name: name,
        owner: owner,
        prerelease: prerelease,
        release_id: release_id,
        repo: repo,
        tag_name: tag,
        target_commitish: commit
    });
}

async function upload_asset(token: string, release_id: number, owner: string, repo: string, file: string, asset_name: string, upload_url: string, overwrite: boolean): Promise<any> {
    const client = new GitHub(token)
    const stat = fs.statSync(file)
    if (!stat.isFile()) {
        throw new Error(`File: ${ file } is not a file.`)
    }

    const assets = await client.repos.listAssetsForRelease({
        owner: owner,
        release_id: release_id,
        repo: repo
    })

    const duplicate_asset = assets.data.find(asset => asset.name === asset_name)
    if (duplicate_asset != null) {
        if (overwrite) {
            await client.repos.deleteReleaseAsset({
                owner: owner,
                repo: repo,
                asset_id: duplicate_asset.id
            })
        }
        else {
            throw new Error(`Duplicate Asset: ${ asset_name }.`)
        }
    }

    return await client.repos.uploadReleaseAsset({
        data: fs.readFileSync(file),
        name: asset_name,
        url: upload_url,
        headers: {
            'content-type': 'binary/octet-stream',
            'content-length': stat.size as number
        },
    })
}

async function main(): Promise<void> {
    try {
        const token = core.getInput('github_token', { required: true })
        const release_name = core.getInput('release_name', { required: false })
        const file = core.getInput('file', { required: false })
        const asset_name = core.getInput('asset_name', { required: false })
        const is_file_glob = Boolean(JSON.parse(core.getInput('is_file_glob', { required: false }) || 'false'))
        const overwrite = Boolean(JSON.parse(core.getInput('overwrite', { required: false }) || 'false'))
        const release_notes = core.getInput('release_notes', { required: false })
        const deletes_existing_release = Boolean(JSON.parse(core.getInput('deletes_existing_release', { required: false }) || 'false'))
        const pre_release = Boolean(JSON.parse(core.getInput('pre_release', { required: false }) || 'false'))
        const prefix_branch_name = Boolean(JSON.parse(core.getInput('prefix_branch_name', { required: false }) || 'false'))
        const suffix_branch_name = Boolean(JSON.parse(core.getInput('suffix_branch_name', { required: false }) || 'false'))
        const draft_release = Boolean(JSON.parse(core.getInput('draft_release', { required: false }) || 'false'))
        const retry_count = parseInt(core.getInput('retry_count', { required: false }) || '0')
        const retry_delay = parseInt(core.getInput('retry_delay', { required: false }) || '5')
        const owner = core.getInput('owner') || context.repo.owner
        const repo = core.getInput('repo') || context.repo.repo
        const tag = (core.getInput('tag', { required: true }) || context.ref).replace('refs/tags/', '')
        const new_tag = (core.getInput('new_tag', { required: false }) || tag).replace('refs/tags/', '')
        const bump_tag = Boolean(JSON.parse(core.getInput('bump_tag', { required: false }) || 'false'))
        const ref = (core.getInput('ref', { required: false }) ? core.getInput('ref', { required: false }).split('/').pop() : undefined) || context.sha

        if (prefix_branch_name && suffix_branch_name) {
            core.setFailed("Error: Cannot set both prefix_branch_name & suffix_branch_name.")
            return
        }

        const branch_name = prefix_branch_name || suffix_branch_name ? context.ref.split('/').pop() || '' : ''
        const prefix = prefix_branch_name && branch_name.length > 0 ? `${ branch_name } - ` : ''
        const suffix = suffix_branch_name && branch_name.length > 0 ? ` - ${ branch_name }` : ''
        const update_prerelease = core.getInput('pre_release', { required: false }) != null
        const update_draft = core.getInput('draft_release', { required: false }) != null

        const release = await get_or_create_release(
            token,
            owner,
            repo,
            `${ prefix }${ release_name }${ suffix }`,
            `${ prefix.replace(/\s/g, '').trim() }${ tag }${ suffix.replace(/\s/g, '') }`,
            ref,
            deletes_existing_release,
            draft_release,
            bump_tag
        )
        
        await update_release(
            token,
            release.id,
            owner,
            repo,
            `${ prefix }${ release_name }${ suffix }`,
            `${ prefix.replace(/\s/g, '').trim() }${ new_tag }${ suffix.replace(/\s/g, '') }`,
            ref,
            release_notes,
            update_prerelease ? pre_release : release.prerelease,
            update_draft ? draft_release : release.draft
        )

        if (file != null) {
            const files = is_file_glob ? glob.sync(file) as [string] : [file]
            const uploads = files.map(file => {
                const file_name = is_file_glob ? path.basename(file) : asset_name || path.basename(file)
                return try_promise(() => upload_asset(token, release.id, owner, repo, file, file_name, release.url, overwrite), retry_delay * 1000, retry_count)
            });

            await Promise.allSettled(uploads)
        }
        core.setOutput('result', 'success')
    } catch (error) {
        core.setFailed(error.message)
    }
}

main()
