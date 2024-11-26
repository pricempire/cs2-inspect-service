import { Controller, Get, Query } from '@nestjs/common'
import { InspectService } from './inspect.service'
import { InspectDto } from './inspect.dto'

@Controller()
export class InspectController {
    constructor(private readonly inspectService: InspectService) { }

    @Get([
        '',
        'inspect',
    ])
    async inspect(
        @Query() query: InspectDto,
    ) {
        return await this.inspectService.inspectItem(query)
    }

    @Get('stats')
    async stats() {
        return this.inspectService.stats()
    }
}
