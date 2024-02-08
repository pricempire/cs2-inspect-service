import { Controller, Get, Query } from '@nestjs/common'
import { InspectService } from './inspect.service'

@Controller('/')
export class InspectController {
    constructor(private readonly inspectService: InspectService) {}

    @Get()
    async inspect(
        @Query()
        query: {
            s?: string
            a?: string
            d?: string
            m?: string
            url?: string
            refresh?: string
        },
    ) {
        return await this.inspectService.inspectItem(query)
    }
}
