import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'
import { GitHub } from '@actions/github'
import { context } from '@actions/github'

const glob = require("glob")

async function get_or_create_release(token: string, owner: string, repo: string, release_name: string | undefined, tag: string, delete_existing: boolean): Promise<{id: number, name: string, url: string}> {
    const client = new GitHub(token)

    try {
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
                draft: true,
                name: release_name,
                owner: owner,
                repo: repo,
                tag_name: tag
            })
            return {
                id: result.data.id,
                name: result.data.name,
                url: result.data.upload_url
            }
        }

        return {
            id: release.data.id,
            name: release.data.name,
            url: release.data.upload_url
        }
    } catch (error) {
        if (error.status === 404) {
            const result = await client.repos.createRelease({
                draft: true,
                name: release_name,
                owner: owner,
                repo: repo,
                tag_name: tag
            })
            return {
                id: result.data.id,
                name: result.data.name,
                url: result.data.upload_url
            }
        }

        throw error;
    }
}

async function update_release_notes(token: string, release_id: number, owner: string, repo: string, name: string, tag: string, commit: string | undefined, notes: string | undefined, prerelease: boolean): Promise<any> {
    const client = new GitHub(token)

    return await client.repos.updateRelease({
        body: notes,
        draft: false,
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
        const owner = core.getInput('owner') || context.repo.owner
        const repo = core.getInput('repo') || context.repo.repo
        const tag = (core.getInput('tag', { required: true }) || context.ref).replace('refs/tags/', '')
        const ref = core.getInput('ref', { required: false })

        const release = await get_or_create_release(token, owner, repo, release_name, tag, deletes_existing_release)
        if (release_notes != null) {
            await update_release_notes(token, release.id, owner, repo, release_name, tag, ref, release_notes, pre_release)
        }

        const files = is_file_glob ? glob.sync(file) as [string] : [file]
        const uploads = files.map(file => {
            const file_name = is_file_glob ? path.basename(file) : asset_name || path.basename(file)
            return upload_asset(token, release.id, owner, repo, file, file_name, release.url, overwrite)
        });

        await Promise.all(uploads)
        core.setOutput('result', 'success')
    } catch (error) {
        core.setFailed(error.message)
    }
}

main()