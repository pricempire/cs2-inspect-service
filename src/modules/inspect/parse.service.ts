import { HttpException, Injectable } from '@nestjs/common'

@Injectable()
export class ParseService {
    public parse(query: {
        s?: string
        a?: string
        d?: string
        m?: string
        url?: string
    }) {
        if (query.url) {
            const params = this.parseLink(query.url)
            if (!params) {
                throw new HttpException('Invalid Inspect URL', 400)
            }
            return params
        }

        if (!('a' in query && 'd' in query && ('s' in query || 'm' in query))) {
            throw new HttpException('Invalid query', 400)
        }

        return {
            s: query.s,
            a: query.a,
            d: query.d,
            m: query.m,
        }
    }
    private parseLink(link: string) {
        try {
            link = decodeURI(link)
        } catch (e) {
            // Catch URI Malformed exceptions
            return
        }

        const groups =
            /^steam:\/\/rungame\/730\/\d+\/[+ ]csgo_econ_action_preview ([SM])(\d+)A(\d+)D(\d+)$/.exec(
                link,
            )

        if (!groups) {
            return
        }

        let s, m

        const a = groups[3],
            d = groups[4]

        if (groups[1] === 'S') {
            s = groups[2]
            m = '0'
        } else if (groups[1] === 'M') {
            m = groups[2]
            s = '0'
        }

        return {
            s,
            m,
            a,
            d,
        }
    }
}
