import { Module } from '@nestjs/common'
import { InspectService } from './inspect.service'
import { InspectController } from './inspect.controller'
import { ParseService } from './parse.service'

@Module({
    providers: [InspectService, ParseService],
    controllers: [InspectController],
})
export class InspectModule {}
