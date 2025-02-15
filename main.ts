import { Message } from '@concrnt/client';
import { Client, CommunityTimelineSchema, MarkdownMessageSchema, MediaMessageSchema, ProfileSchema, Schemas } from '@concrnt/worldlib'
import express from 'express'
import json2emap from "json2emap";
import rateLimit from 'express-rate-limit'

const subkey = process.env.SUBKEY
const proxyIP = process.env.PROXY_IP

if (!subkey) {
    console.error('SUBKEY not set')
    process.exit(1)
}

const app = express()
app.set('trust proxy', proxyIP)
app.use(express.json())
app.listen(3000, () => console.log("server running on port 3000"))

interface Response {
    name: string
    entries: Entry[]
}

interface Media {
    type: string
    url: string
}

interface Reaction {
    url: string
    count: number
}

interface Entry {
    name: string
    avatar: string
    message: string
    medias: Media[]
    timestamp: string
    reactions: Reaction[]
}

const postLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 2,
  message: '5分間に2回しか投稿できません。少し待ってから再度お試しください。'
});

const nowEpsilon = 3000 // 3 seconds

export const humanReadableTimeDiff = (time: Date): string => {
    const current = new Date()
    const msPerMinute = 60 * 1000
    const msPerHour = msPerMinute * 60
    const msPerDay = msPerHour * 24

    const elapsed = current.getTime() - time.getTime()

    if (Math.abs(elapsed) < nowEpsilon) {
        return 'たった今'
    }

    const postfix = elapsed < 0 ? '後' : '前'

    if (elapsed < msPerMinute) {
        return `${Math.round(Math.abs(elapsed) / 1000)}秒${postfix}`
    } else if (elapsed < msPerHour) {
        return `${Math.round(Math.abs(elapsed) / msPerMinute)}分${postfix}`
    } else if (elapsed < msPerDay) {
        return `${Math.round(Math.abs(elapsed) / msPerHour)}時間${postfix}`
    } else {
        return (
            (current.getFullYear() === time.getFullYear() ? '' : `${time.getFullYear()}-`) +
            `${String(time.getMonth() + 1).padStart(2, '0')}-` +
            `${String(time.getDate()).padStart(2, '0')} ` +
            `${String(time.getHours()).padStart(2, '0')}:` +
            `${String(time.getMinutes()).padStart(2, '0')}`
        )
    }
}


const getTimeline = async (client: Client, timelineFQID: string): Promise<Response> => {

    const timeline = await client.getTimeline<CommunityTimelineSchema>(timelineFQID)
    if (!timeline) {
        throw new Error('Timeline not found')
    }
    const name = timeline.document.body.name
    const elements = await client.api.getTimelineRecent([timelineFQID])
    const entries: Entry[] = []
    for (const e of elements) {
        try {
            const author = await client.api.getProfileBySemanticID<ProfileSchema>('world.concrnt.p', e.owner)
            const msgBase = await client.api.getMessageWithAuthor<any>(e.resourceID, e.owner)

            let name = msgBase.parsedDoc.body.profileOverride?.username ?? author.parsedDoc.body.username ?? 'Anonymous'
            let avatar = msgBase.parsedDoc.body.profileOverride?.avatar ?? author.parsedDoc.body.avatar ??  ''

            if (msgBase.parsedDoc.body.profileOverride?.profileID) {
                const profile = await client.api.getProfile<ProfileSchema>(msgBase.parsedDoc.body.profileOverride.profileID, msgBase.author)
                if (profile) {
                    name = profile.parsedDoc.body.username ?? name
                    avatar = profile.parsedDoc.body.avatar ?? avatar
                }
            }

            const assCounts = await client.api.getMessageAssociationCountsByTarget(e.resourceID, e.owner, {
                schema: Schemas.reactionAssociation,
            })
            const reactions: Reaction[] = []

            for (const [reaction, count] of Object.entries(assCounts)) {
                reactions.push({
                    url: reaction,
                    count: count
                })
            }

            switch (msgBase.schema) {
                case Schemas.markdownMessage: 
                case Schemas.plaintextMessage: {
                    const message = msgBase as Message<MarkdownMessageSchema>
                    entries.push({
                        name: name,
                        avatar: avatar,
                        message: message.parsedDoc.body.body,
                        timestamp: humanReadableTimeDiff(new Date(e.cdate)),
                        medias: [],
                        reactions: reactions
                    })
                    break
                }
                case Schemas.mediaMessage: {
                    const message = msgBase as Message<MediaMessageSchema>

                    const medias: Media[] = []
                    for (const media of message.parsedDoc.body.medias ?? []) {
                        medias.push({
                            type: media.mediaType,
                            url: media.mediaURL
                        })
                    }

                    entries.push({
                        name: name,
                        avatar: avatar,
                        message: message.parsedDoc.body.body,
                        medias: medias,
                        timestamp: humanReadableTimeDiff(new Date(e.cdate)),
                        reactions: reactions
                    })
                }

            }


        } catch (e) {
            console.error(e)
        }
    }

    return {
        name: name,
        entries: entries
    }

}

let client: Client

Client.createFromSubkey(subkey).then((c) => {
    client = c
})

app.get('/timeline/:timelineFQID', async (req, res) => {
    const timelineFQID = req.params.timelineFQID
    const response = await getTimeline(client, timelineFQID)

    res.send(json2emap(response))
})

app.post('/timeline/:timelineFQID', postLimiter, async (req, res) => {
    const timelineFQID = req.params.timelineFQID

    const timeline = await client.getTimeline<CommunityTimelineSchema>(timelineFQID)
    if (!timeline) {
        res.status(404).send('指定のタイムラインが見つかりませんでした。')
        return
    }
    if (timeline.host !== client.host) {
        res.status(403).send('このタイムラインへの投稿はこのサーバーからは許可されていません。')
        return
    }

    const username = req.body.username
    const avatarResDB = req.body.iconResdb
    const avatar = 'https://assets.resonite.com/' + avatarResDB.split('///')[1].split('.')[0]
    const message = req.body.message

    await client.createMarkdownCrnt(message, [timelineFQID], {
        profileOverride: {
            username: username,
            avatar: avatar
        }
    })

    res.send('ok')
})

