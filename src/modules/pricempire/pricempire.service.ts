import { HttpService } from '@nestjs/axios'
import { Injectable } from '@nestjs/common'
import { firstValueFrom } from 'rxjs'

@Injectable()
export class PricempireService {
    private readonly PRICEMPIRE_ENDPOINT = `https://inspect.pricempire.com/?url=`
    constructor(private readonly httpService: HttpService) {}

    async ping(query: {
        s?: string
        a?: string
        d?: string
        m?: string
    }): Promise<void> {
        try {
            const queryString = Object.keys(query)
                .map((key) => key + '=' + query[key])
                .join('&')

            await firstValueFrom(
                this.httpService.post(this.PRICEMPIRE_ENDPOINT + queryString, {
                    timeout: 5000,
                }),
            )
        } catch {
            // DO NOTHING - We don't care about the response
        }
    }
}
