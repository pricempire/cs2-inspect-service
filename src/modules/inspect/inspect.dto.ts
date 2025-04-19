; import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator'
import { Transform } from 'class-transformer'

export class InspectDto {
    @IsOptional()
    @IsString()
    // example: 76561198023809011
    @Matches(/^7656\d{13}$/, {
        message: 'Invalid Steam ID',
    })
    s?: string

    @IsOptional()
    @IsString()
    // example: 1
    @Matches(/^\d+$/, {
        message: 'Invalid Asset ID',
    })
    a?: string

    @IsOptional()
    @IsString()
    // example: 1
    @Matches(/^\d+$/, {
        message: 'Invalid Definition ID',
    })
    d?: string

    @IsOptional()
    @IsString()
    // example: 1
    @Matches(/^\d+$/, {
        message: 'Invalid Market ID',
    })
    m?: string

    @IsOptional()
    @Transform(({ value }) => value === 'true')
    refresh?: boolean

    @IsString({
        message: 'Invalid password, please contact support if you need access.',
    })
    @IsOptional()
    password?: string

    @IsOptional()
    @IsString()
    // example: steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561198023809011A40368145941D14586214085613790969
    // @Matches(/^steam:\/\/rungame\/730\/.*?\/.*?csgo_econ_action_preview.*?[SM]7656\d{13}A\d+D\d+$/, {
    //     message: 'Invalid Steam URL',
    // }) 
    // TODO: Add validation
    url?: string

    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => value === 'true')
    reply?: boolean;

    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => value === 'true')
    lowPriority?: boolean;
}
